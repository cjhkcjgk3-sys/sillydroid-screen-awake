const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const source = fs.readFileSync(require('node:path').join(__dirname, '../index.js'), 'utf8')
    .replace(/export function /g, 'function ');
function setup() {
    const nodes = new Map();
    const media = [];
    const timers = new Map();
    let timerId = 0;
    class Element {
        constructor(tag) { this.tag = tag; this.paused = true; this.dataset = {}; this.style = {}; this.listeners = {}; this.classList = { contains: () => false }; }
        set innerHTML(html) { for (const [, id] of html.matchAll(/id="([^"]+)"/g)) nodes.set(id, new Element('input')); }
        setAttribute() {}
        removeAttribute() {}
        append(e) { if (e.id) nodes.set(e.id, e); }
        remove() { if (this.id) nodes.delete(this.id); this.removed = true; }
        addEventListener(name, handler) { this.listeners[name] = handler; }
        async play() { this.paused = false; }
        pause() { this.paused = true; }
        load() {}
    }
    nodes.set('extensions_settings', new Element('div'));
    const listeners = new Map();
    const bus = { on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); }, removeListener(name, fn) { listeners.get(name)?.delete(fn); } };
    const document = { readyState: 'loading', visibilityState: 'visible', body: new Element('body'),
        documentElement: new Element('html'), addEventListener() {}, removeEventListener() {},
        getElementById: id => nodes.get(id),
        createElement(tag) { const e = new Element(tag); if (['video', 'audio'].includes(tag)) media.push(e); return e; } };
    const context = vm.createContext({ document, window: { addEventListener() {}, removeEventListener() {} },
        navigator: {}, console, Blob, URL, Uint8Array, DataView,
        MutationObserver: class { observe() {} disconnect() {} },
        setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
        setInterval: fn => { timers.set(++timerId, fn); return timerId; }, clearInterval: id => timers.delete(id),
        SillyTavern: { getContext: () => ({ extensionSettings: {}, saveSettingsDebounced() {}, eventSource: bus }) },
    });
    const run = code => vm.runInContext(code, context);
    run(source);
    run(`isVideoFallbackSupported = () => true; createKeepAwakeClipUrl = async () => URL.createObjectURL(new Blob(['video fixture'])); mountExtension(); activeSettings.enabled = true;`);
    return { run, nodes, media, listeners, document, timers };
}
async function settle() { for (let i = 0; i < 16; i++) await Promise.resolve(); }

test('task starts video even when foreground screen lock succeeds', async () => {
    const h = setup();
    h.run(`tryWakeLock = async () => true; addHold('external:batch');`);
    await settle();
    assert.equal(h.run('keepAwakeVideo.paused'), false);
    assert.equal(h.run('taskAudio.paused'), false);
});
test('visibilitychange and reconciliation retain task media in background', async () => {
    const h = setup(); h.run("addHold('external:batch')"); await settle();
    h.document.visibilityState = 'hidden'; h.run('visibilityChangeHandler(); reconcile()'); await settle();
    assert.equal(h.run('keepAwakeVideo.paused'), false);
    assert.equal(h.run('taskAudio.paused'), false);
});
test('finishing one generation does not release whole batch', async () => {
    const h = setup(); h.run("addHold('external:batch'); addHold('tavern-generation')"); await settle();
    h.document.visibilityState = 'hidden'; h.run("removeHold('tavern-generation'); reconcile()"); await settle();
    assert.equal(h.run('keepAwakeVideo.paused'), false);
    h.run("removeHold('external:batch')"); await settle();
    assert.equal(h.run('keepAwakeVideo.paused'), true);
    assert.equal(h.run('taskAudio'), null);
});
test('ordinary background page releases media without a task', async () => {
    const h = setup(); h.run('engage(activeSettings)'); await settle();
    h.document.visibilityState = 'hidden'; h.run('visibilityChangeHandler(); reconcile()'); await settle();
    assert.equal(h.run('keepAwakeVideo.paused'), true);
});
test('offline or elapsed time does not discard task holds', async () => {
    const h = setup(); h.run("addHold('external:retrying')"); await settle();
    h.document.visibilityState = 'hidden';
    for (let i = 0; i < 10; i++) h.run('reconcile()');
    assert.equal(h.run("holds.has('external:retrying')"), true);
    assert.equal(h.run('keepAwakeVideo.paused'), false);
});
test('disable cleans media, URL ownership and generation listeners', async () => {
    const h = setup(); h.run("addHold('external:batch')"); await settle(); h.run('disable()'); await settle();
    assert.equal(h.run('keepAwakeVideo'), null);
    assert.equal(h.run('taskAudio'), null);
    assert.equal(h.run('keepAwakeClipUrl'), null);
    assert.equal([...h.listeners.values()].reduce((n, s) => n + s.size, 0), 0);
    assert.equal(h.timers.size, 0);
});
test('disable during asynchronous clip creation prevents late media resurrection', async () => {
    const h = setup();
    h.run(`let finishClip; createKeepAwakeClipUrl = () => new Promise(resolve => finishClip = resolve); addHold('external:batch'); disable(); finishClip(URL.createObjectURL(new Blob(['late'])));`);
    await settle();
    assert.equal(h.run('keepAwakeVideo'), null);
    assert.equal(h.run('taskAudio'), null);
});
test('switch off background mode restores ordinary foreground behavior', async () => {
    const h = setup(); h.run("addHold('external:batch')"); await settle();
    h.document.visibilityState = 'hidden'; h.run('activeSettings.backgroundTaskVideo = false; engage(activeSettings)'); await settle();
    assert.equal(h.run('keepAwakeVideo.paused'), true);
    assert.equal(h.run('taskAudio'), null);
});
test('audio helper can be switched off independently', async () => {
    const h = setup(); h.run("activeSettings.taskSilentAudio = false; addHold('external:batch')"); await settle();
    assert.equal(h.run('keepAwakeVideo.paused'), false);
    assert.equal(h.run('taskAudio'), null);
});
test('playback rejection retains task and produces an actionable status', async () => {
    const h = setup(); const original = h.document.createElement;
    h.document.createElement = tag => { const e = original(tag); if (tag === 'video') e.play = async () => { throw Object.assign(new Error('blocked'), { name: 'NotAllowedError' }); }; return e; };
    h.run("addHold('external:batch')"); await settle();
    assert.equal(h.run('hasHeldWork()'), true);
    assert.equal(h.nodes.get('sillydroid-screen-awake-status').dataset.state, 'warning');
    assert.equal(h.run('lastVideoError'), 'NotAllowedError');
});
test('task holds prevent idle sleep', async () => {
    const h = setup(); h.run("addHold('external:batch')"); await settle(); h.run("sleepNow('idle')");
    assert.equal(h.run('asleep'), false);
    assert.equal(h.run('keepAwakeVideo.paused'), false);
});
test('badge observer starts and releases a whole novel task in background', async () => {
    const h = setup(); let running = true;
    h.nodes.set('nag-status', { classList: { contains: value => value === 'running' && running } });
    h.run('pollNovelTask()'); await settle(); h.document.visibilityState = 'hidden';
    assert.equal(h.run("holds.has('novel-task')"), true);
    running = false; h.run('pollNovelTask()'); await settle();
    assert.equal(h.run('keepAwakeVideo.paused'), true);
    assert.equal(h.run('taskAudio'), null);
});
