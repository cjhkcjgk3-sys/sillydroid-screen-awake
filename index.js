const extensionId = 'sillydroid-screen-awake';
const panelId = 'sillydroid-screen-awake-panel';
const checkboxId = 'sillydroid-screen-awake-enabled';
const statusId = 'sillydroid-screen-awake-status';
const diagnosticsId = 'sillydroid-screen-awake-diagnostics';
const defaults = { enabled: false };

const MODE_NONE = 'none';
const MODE_WAKE_LOCK = 'wakelock';
const MODE_VIDEO = 'video';

let wakeLockSentinel = null;
let wakeLockRequest = null;
let extensionActive = true;
let mountObserver = null;
let visibilityChangeHandler = null;
let pageHideHandler = null;
let pageShowHandler = null;
let activeSettings = null;
let activeMode = MODE_NONE;
let retryTimer = null;
let retryDelay = 1000;
let mountErrorLogged = false;
let keepAwakeVideo = null;
let keepAwakeVideoRequest = null;
let keepAwakeClipUrl = null;
const maxRetryDelay = 60000;

function getExtensionSettings() {
    const context = globalThis.SillyTavern?.getContext?.();
    if (!context?.extensionSettings || typeof context.saveSettingsDebounced !== 'function') {
        throw new Error('SillyTavern.getContext is unavailable');
    }

    const settings = context.extensionSettings[extensionId] ??= {};
    for (const [key, value] of Object.entries(defaults)) {
        if (settings[key] === undefined) {
            settings[key] = value;
        }
    }

    return { context, settings };
}

function setStatus(message, state) {
    const status = document.getElementById(statusId);
    if (!status) {
        return;
    }

    status.textContent = message;
    status.dataset.state = state;
}

function setMode(mode) {
    activeMode = mode;
    const panel = document.getElementById(panelId);
    if (panel) {
        panel.dataset.mode = mode;
    }
}

function isSecure() {
    return globalThis.isSecureContext === true;
}

function isWakeLockSupported() {
    return Boolean(navigator.wakeLock && typeof navigator.wakeLock.request === 'function');
}

function isVideoFallbackSupported() {
    return typeof MediaRecorder === 'function'
        && typeof Blob === 'function'
        && typeof HTMLCanvasElement !== 'undefined'
        && typeof HTMLCanvasElement.prototype.captureStream === 'function';
}

function renderDiagnostics() {
    const node = document.getElementById(diagnosticsId);
    if (!node) {
        return;
    }

    const mark = (ok) => (ok ? '✓' : '✗');
    node.textContent = `环境自检：安全上下文 ${mark(isSecure())} · 唤醒锁 ${mark(isWakeLockSupported())} · 视频保活 ${mark(isVideoFallbackSupported())}`;
}

// ---------------------------------------------------------------------------
// 第一档：Screen Wake Lock API
// ---------------------------------------------------------------------------

function clearWakeLockRetry() {
    if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }
    retryDelay = 1000;
}

function scheduleWakeLockRetry(settings) {
    if (retryTimer !== null || !extensionActive || !settings.enabled) {
        return;
    }

    const delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, maxRetryDelay);
    retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!extensionActive || !settings.enabled || document.visibilityState !== 'visible') {
            return;
        }
        void engage(settings);
    }, delay);
}

async function releaseWakeLock() {
    clearWakeLockRetry();
    const sentinel = wakeLockSentinel;
    wakeLockSentinel = null;
    if (sentinel && !sentinel.released) {
        try {
            await sentinel.release();
        } catch {
            // The browser may already have released the lock while hiding the page.
        }
    }
}

function onWakeLockReleased(sentinel, settings) {
    if (wakeLockSentinel && wakeLockSentinel !== sentinel) {
        // A newer lock already replaced this one; a stale release event must not touch it.
        return;
    }

    if (wakeLockSentinel === sentinel) {
        wakeLockSentinel = null;
    }

    if (!extensionActive) {
        return;
    }

    if (!settings.enabled) {
        setStatus('屏幕常亮已关闭。', 'off');
    } else if (document.visibilityState !== 'visible') {
        setStatus('酒馆在后台，屏幕常亮已暂停。返回酒馆后会自动恢复。', 'paused');
    } else {
        setStatus('系统收回了屏幕唤醒锁，正在重新申请…', 'pending');
        scheduleWakeLockRetry(settings);
    }
}

async function tryWakeLock(settings) {
    if (!isWakeLockSupported()) {
        return false;
    }

    if (wakeLockSentinel && !wakeLockSentinel.released) {
        return true;
    }

    if (wakeLockRequest) {
        try {
            await wakeLockRequest;
        } catch {
            // A previous attempt failed; report the current state below.
        }
        return Boolean(wakeLockSentinel && !wakeLockSentinel.released);
    }

    wakeLockRequest = (async () => {
        try {
            const sentinel = await navigator.wakeLock.request('screen');
            if (!extensionActive || !settings.enabled || document.visibilityState !== 'visible') {
                await sentinel.release();
                return;
            }

            wakeLockSentinel = sentinel;
            sentinel.addEventListener('release', () => onWakeLockReleased(sentinel, settings), { once: true });
            retryDelay = 1000;
        } catch (error) {
            console.debug(`[${extensionId}] screen wake lock unavailable`, error);
        } finally {
            wakeLockRequest = null;
        }
    })();

    try {
        await wakeLockRequest;
    } catch {
        // Handled in the worker above.
    }

    return Boolean(wakeLockSentinel && !wakeLockSentinel.released);
}

// ---------------------------------------------------------------------------
// 第二档：静音视频保活
//
// 浏览器把「正在播放带视频轨的媒体」当作正在放视频，从而申请显示常亮
// （NoSleep.js 十余年来用的就是这套）。所以这里现场录制一段 16×16、
// 无音频、循环播放的极小 WebM，贴着屏幕角落摆一个 2×2 像素的播放器。
// 注意：纯音频（振荡器）在 Android 上不生效，必须有真实视频轨。
// ---------------------------------------------------------------------------

async function createKeepAwakeClipUrl() {
    if (!isVideoFallbackSupported()) {
        return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const context = canvas.getContext('2d');
    if (!context) {
        return null;
    }
    context.fillStyle = '#000';
    context.fillRect(0, 0, 16, 16);

    const stream = canvas.captureStream(2);
    const mimeTypes = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'];
    const mimeType = mimeTypes.find((type) => typeof MediaRecorder.isTypeSupported === 'function'
        && MediaRecorder.isTypeSupported(type));

    if (!mimeType) {
        stream.getTracks().forEach((track) => track.stop());
        return null;
    }

    const chunks = [];
    const blob = await new Promise((resolve) => {
        let recorder;
        try {
            recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8000 });
        } catch {
            resolve(null);
            return;
        }

        const finish = (value) => resolve(value);
        recorder.ondataavailable = (event) => {
            if (event.data?.size) {
                chunks.push(event.data);
            }
        };
        recorder.onstop = () => finish(chunks.length ? new Blob(chunks, { type: mimeType }) : null);
        recorder.onerror = () => finish(null);
        recorder.start();
        setTimeout(() => {
            try {
                recorder.stop();
            } catch {
                // Already stopped.
            }
        }, 300);
    });

    stream.getTracks().forEach((track) => track.stop());

    if (!blob?.size) {
        return null;
    }

    return URL.createObjectURL(blob);
}

async function createAndPlayKeepAwakeVideo() {
    if (!isVideoFallbackSupported() || !document.body) {
        return false;
    }

    keepAwakeClipUrl = await createKeepAwakeClipUrl();
    if (!keepAwakeClipUrl) {
        return false;
    }

    const video = document.createElement('video');
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.playsInline = true;
    video.tabIndex = -1;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('aria-hidden', 'true');
    video.setAttribute('disablepictureinpicture', '');
    video.className = 'sillydroid-screen-awake-keepalive';
    video.src = keepAwakeClipUrl;
    document.body.append(video);
    keepAwakeVideo = video;

    try {
        await video.play();
    } catch (error) {
        console.debug(`[${extensionId}] keep-awake video could not play`, error);
        destroyKeepAwakeVideo();
        return false;
    }

    return true;
}

async function startKeepAwakeVideo() {
    if (keepAwakeVideo) {
        if (keepAwakeVideo.paused) {
            try {
                await keepAwakeVideo.play();
            } catch {
                return false;
            }
        }
        return !keepAwakeVideo.paused;
    }

    if (keepAwakeVideoRequest) {
        return keepAwakeVideoRequest;
    }

    keepAwakeVideoRequest = createAndPlayKeepAwakeVideo();
    try {
        return await keepAwakeVideoRequest;
    } finally {
        keepAwakeVideoRequest = null;
    }
}

function pauseKeepAwakeVideo() {
    if (!keepAwakeVideo) {
        return;
    }

    try {
        keepAwakeVideo.pause();
    } catch {
        // Ignore; the element is going away anyway.
    }
}

function destroyKeepAwakeVideo() {
    if (keepAwakeVideo) {
        try {
            keepAwakeVideo.pause();
            keepAwakeVideo.removeAttribute('src');
            keepAwakeVideo.load();
            keepAwakeVideo.remove();
        } catch {
            // Ignore cleanup failures.
        }
        keepAwakeVideo = null;
    }

    if (keepAwakeClipUrl) {
        try {
            URL.revokeObjectURL(keepAwakeClipUrl);
        } catch {
            // Ignore.
        }
        keepAwakeClipUrl = null;
    }
}

// ---------------------------------------------------------------------------
// 调度：先唤醒锁，不行再视频保活
// ---------------------------------------------------------------------------

async function engage(settings) {
    if (!extensionActive || !settings.enabled) {
        return;
    }

    if (document.visibilityState !== 'visible') {
        setStatus('酒馆在后台，屏幕常亮已暂停。返回酒馆后会自动恢复。', 'paused');
        return;
    }

    if (await tryWakeLock(settings)) {
        if (keepAwakeVideo) {
            destroyKeepAwakeVideo();
        }
        setMode(MODE_WAKE_LOCK);
        setStatus('屏幕常亮已开启（系统唤醒锁）。酒馆页面保持前台时不会自动关屏。', 'active');
        renderDiagnostics();
        return;
    }

    if (await startKeepAwakeVideo()) {
        setMode(MODE_VIDEO);
        setStatus('屏幕常亮已开启（视频保活）。未能使用系统唤醒锁，改用静音循环视频让系统认为正在播放视频。', 'active');
        renderDiagnostics();
        return;
    }

    setMode(MODE_NONE);
    setStatus('当前浏览器既没有屏幕唤醒锁，也无法播放保活视频，屏幕仍会按系统设置关闭。', 'unsupported');
    renderDiagnostics();
}

// ---------------------------------------------------------------------------
// 界面与生命周期
// ---------------------------------------------------------------------------

function mountExtension() {
    if (document.getElementById(panelId)) {
        return true;
    }

    const settingsRoot = document.getElementById('extensions_settings')
        ?? document.getElementById('extensions_settings2');
    if (!settingsRoot) {
        return false;
    }

    const { context, settings } = getExtensionSettings();
    activeSettings = settings;
    const panel = document.createElement('section');
    panel.id = panelId;
    panel.className = 'inline-drawer sillydroid-screen-awake-panel';
    panel.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>屏幕常亮</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down" aria-hidden="true"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label sillydroid-screen-awake-toggle" for="${checkboxId}">
                <input id="${checkboxId}" type="checkbox" />
                <span>保持屏幕常亮</span>
            </label>
            <p class="sillydroid-screen-awake-description">
                仅在酒馆页面位于前台时阻止屏幕自动关闭。优先使用系统屏幕唤醒锁；不支持时退回静音循环视频保活。
                不播放声音，也不改变酒馆的生成、消息和网络请求。
            </p>
            <p id="${statusId}" class="sillydroid-screen-awake-status" role="status" aria-live="polite"></p>
            <p id="${diagnosticsId}" class="sillydroid-screen-awake-diagnostics"></p>
        </div>`;
    settingsRoot.append(panel);

    const checkbox = document.getElementById(checkboxId);
    checkbox.checked = settings.enabled === true;
    checkbox.addEventListener('change', async () => {
        settings.enabled = checkbox.checked;
        context.saveSettingsDebounced();

        if (settings.enabled) {
            await engage(settings);
        } else {
            pauseKeepAwakeVideo();
            destroyKeepAwakeVideo();
            await releaseWakeLock();
            setMode(MODE_NONE);
            setStatus('屏幕常亮已关闭。', 'off');
        }
    });

    renderDiagnostics();

    if (settings.enabled) {
        void engage(settings);
    } else {
        setStatus('默认关闭。开启后，屏幕只在酒馆页面前台时保持常亮。', 'off');
    }

    visibilityChangeHandler = () => {
        if (!extensionActive) {
            return;
        }

        if (document.visibilityState === 'visible') {
            if (settings.enabled) {
                void engage(settings);
            }
            return;
        }

        pauseKeepAwakeVideo();
        if (settings.enabled) {
            setStatus('酒馆在后台，屏幕常亮已暂停。返回酒馆后会自动恢复。', 'paused');
        }
        void releaseWakeLock();
    };
    document.addEventListener('visibilitychange', visibilityChangeHandler);

    return true;
}

function initializeExtension() {
    if (!extensionActive) {
        return;
    }

    if (!pageHideHandler) {
        pageHideHandler = () => {
            mountObserver?.disconnect();
            mountObserver = null;
            pauseKeepAwakeVideo();
            void releaseWakeLock();
        };
        window.addEventListener('pagehide', pageHideHandler);
    }
    if (!pageShowHandler) {
        pageShowHandler = () => {
            initializeExtension();
            if (activeSettings?.enabled) {
                void engage(activeSettings);
            }
        };
        window.addEventListener('pageshow', pageShowHandler);
    }

    try {
        if (mountExtension()) {
            mountObserver?.disconnect();
            mountObserver = null;
            return;
        }
    } catch (error) {
        // getContext()/saveSettingsDebounced can be missing while the host is still booting.
        // Keep watching instead of giving up permanently.
        if (!mountErrorLogged) {
            mountErrorLogged = true;
            console.warn(`[${extensionId}] Not ready yet, waiting for SillyTavern context`, error);
        }
    }

    if (mountObserver) {
        return;
    }

    mountObserver = new MutationObserver(() => {
        let mounted = false;
        try {
            mounted = mountExtension();
        } catch (error) {
            if (!mountErrorLogged) {
                mountErrorLogged = true;
                console.warn(`[${extensionId}] Not ready yet, waiting for SillyTavern context`, error);
            }
        }

        if (mounted) {
            mountErrorLogged = false;
            mountObserver?.disconnect();
            mountObserver = null;
        }
    });

    mountObserver.observe(document.documentElement, { childList: true, subtree: true });
}

export function enable() {
    extensionActive = true;
    initializeExtension();
}

export function disable() {
    extensionActive = false;
    mountObserver?.disconnect();
    mountObserver = null;

    if (visibilityChangeHandler) {
        document.removeEventListener('visibilitychange', visibilityChangeHandler);
        visibilityChangeHandler = null;
    }

    if (pageHideHandler) {
        window.removeEventListener('pagehide', pageHideHandler);
        pageHideHandler = null;
    }
    if (pageShowHandler) {
        window.removeEventListener('pageshow', pageShowHandler);
        pageShowHandler = null;
    }

    destroyKeepAwakeVideo();
    void releaseWakeLock();
    activeSettings = null;
    setMode(MODE_NONE);
    mountErrorLogged = false;
    document.getElementById(panelId)?.remove();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeExtension, { once: true });
} else {
    initializeExtension();
}
