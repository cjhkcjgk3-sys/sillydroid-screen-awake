const extensionId = 'sillydroid-screen-awake';
const panelId = 'sillydroid-screen-awake-panel';
const checkboxId = 'sillydroid-screen-awake-enabled';
const statusId = 'sillydroid-screen-awake-status';
const diagnosticsId = 'sillydroid-screen-awake-diagnostics';
const dimId = 'sillydroid-screen-awake-dim';
const dimSliderId = 'sillydroid-screen-awake-dim-slider';
const dimValueId = 'sillydroid-screen-awake-dim-value';
const idleInputId = 'sillydroid-screen-awake-idle';
const guardCheckboxId = 'sillydroid-screen-awake-guard';
const audioCheckboxId = 'sillydroid-screen-awake-audio';
const backgroundCheckboxId = 'sillydroid-screen-awake-background';

const defaults = {
    enabled: false,
    dimLevel: 0,
    idleTimeoutMinutes: 10,
    guardNovelTask: true,
    backgroundTaskVideo: true,
    taskSilentAudio: true,
};

const MODE_NONE = 'none';
const MODE_WAKE_LOCK = 'wakelock';
const MODE_VIDEO = 'video';

// 小说自动生成器（Novel-Auto-Generator）把运行状态渲染在这个徽章上。
const NOVEL_STATUS_ELEMENT_ID = 'nag-status';
const TASK_POLL_INTERVAL_MS = 2000;
const TASK_END_GRACE_MS = 60000;
// 对账层：事件丢了也能收敛回来的周期（最后一层筛子）
const RECONCILE_INTERVAL_MS = 5000;
// 保活申请连续失败时的冷却，避免对账层每 5 秒重试一次录像
const ENGAGE_FAILURE_COOLDOWN_MS = 30000;
const MAX_DIM_PERCENT = 80;
const MAX_IDLE_MINUTES = 600;

let wakeLockSentinel = null;
let wakeLockRequest = null;
let extensionActive = true;
let mountObserver = null;
let visibilityChangeHandler = null;
let pageHideHandler = null;
let pageShowHandler = null;
let activityHandlers = null;
let activeSettings = null;
let activeMode = MODE_NONE;
let retryTimer = null;
let retryDelay = 1000;
let mountErrorLogged = false;
let keepAwakeVideo = null;
let keepAwakeVideoRequest = null;
let keepAwakeClipUrl = null;
let dimOverlay = null;
let idleTimer = null;
let taskPollTimer = null;
let novelStatusObserver = null;
let observedNovelStatus = null;
let lastActivityAt = Date.now();
let asleep = false;
let novelTaskRunning = false;
let generationSubscriptions = [];
let mediaRevision = 0;
let lastVideoError = '';
let lastVideoProgressAt = 0;
let taskAudio = null;
let taskAudioUrl = null;
let audioPlayPending = false;
let lastAudioError = '';
let lastAudioAttemptAt = 0;
let publicApiInstalled = false;
let reconcileTimer = null;
let lastEngageFailedAt = 0;
const holds = new Set();
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

// ---------------------------------------------------------------------------
// 功耗：页面压暗（黑层叠加，只降低发光、不拦截点击）
// ---------------------------------------------------------------------------

function clampDim(level) {
    const value = Number(level);
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.min(MAX_DIM_PERCENT, Math.max(0, Math.round(value)));
}

function applyDim(level) {
    const percent = clampDim(level);

    if (!document.body) {
        return;
    }

    if (!dimOverlay) {
        dimOverlay = document.createElement('div');
        dimOverlay.id = dimId;
        dimOverlay.className = 'sillydroid-screen-awake-dim';
        dimOverlay.setAttribute('aria-hidden', 'true');
        document.body.append(dimOverlay);
    }

    dimOverlay.style.opacity = String(percent / 100);
    dimOverlay.style.display = percent > 0 ? 'block' : 'none';

    const label = document.getElementById(dimValueId);
    if (label) {
        label.textContent = `${percent}%`;
    }
}

function removeDim() {
    if (dimOverlay) {
        dimOverlay.remove();
        dimOverlay = null;
    }
}

// ---------------------------------------------------------------------------
// 任务守护：小说自动生成器 / 酒馆生成中
// ---------------------------------------------------------------------------

function isNovelTaskRunning() {
    const node = document.getElementById(NOVEL_STATUS_ELEMENT_ID);
    if (!node?.classList || typeof node.classList.contains !== 'function') {
        return false;
    }

    return node.classList.contains('running');
}

function hasHeldWork() {
    return holds.size > 0;
}

function clearIdleTimer() {
    if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
}

function addHold(reason) {
    if (!extensionActive) {
        return;
    }

    holds.add(reason);
    clearIdleTimer();
    asleep = false;
    if (activeSettings?.enabled) {
        void engage(activeSettings);
    }
}

function removeHold(reason) {
    holds.delete(reason);
    if (extensionActive && activeSettings?.enabled) {
        void engage(activeSettings);
    }
}

// Elapsed time and missing callbacks do not establish task failure.

function formatMinutes(minutes) {
    const value = Number(minutes);
    if (!Number.isFinite(value) || value <= 0) {
        return '自定义时长';
    }
    if (value < 1) {
        return `${Math.max(1, Math.round(value * 60))} 秒`;
    }
    return `${value} 分钟`;
}

function sleepNow(reason) {
    if (!extensionActive) {
        return;
    }
    if (hasHeldWork()) {
        return;
    }

    asleep = true;
    clearIdleTimer();
    pauseKeepAwakeVideo();
    stopTaskAudio();
    void releaseWakeLock();
    setMode(MODE_NONE);

    if (reason === 'task-ended') {
        setStatus('小说生成任务已结束，已自动释放唤醒锁。触摸屏幕或按键会重新保持常亮。', 'idle');
    } else {
        setStatus(`已休眠：${formatMinutes(activeSettings?.idleTimeoutMinutes)}无操作，屏幕可以自动关闭了。触摸屏幕会重新保持常亮。`, 'idle');
    }
}

function armIdleTimer() {
    clearIdleTimer();

    if (!extensionActive || !activeSettings?.enabled || asleep || hasHeldWork()) {
        return;
    }

    const minutes = Number(activeSettings.idleTimeoutMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
        return;
    }

    idleTimer = setTimeout(() => {
        idleTimer = null;
        if (!extensionActive || !activeSettings?.enabled || asleep) {
            return;
        }
        if (hasHeldWork()) {
            return;
        }
        sleepNow('idle');
    }, minutes * 60000);
}

function noteActivity() {
    lastActivityAt = Date.now();

    if (asleep) {
        asleep = false;
        if (extensionActive && activeSettings?.enabled) {
            void engage(activeSettings);
        }
    }

    if (wantsTaskVideo() && (!keepAwakeVideo || keepAwakeVideo.paused || taskAudio?.paused)) {
        lastAudioAttemptAt = 0;
        void engage(activeSettings);
    }

    // 无论刚才是唤醒还是常规活动，都要重新起表——否则「点一下屏幕」之后
    // 计时器不会被重新武装，屏幕会一直亮到下一次活动为止。
    armIdleTimer();
}

function startNovelTaskPolling() {
    if (taskPollTimer !== null) {
        return;
    }

    taskPollTimer = setInterval(() => {
        if (!extensionActive) {
            return;
        }
        pollNovelTask();
    }, TASK_POLL_INTERVAL_MS);

    pollNovelTask();
}

function stopNovelTaskPolling() {
    novelStatusObserver?.disconnect();
    novelStatusObserver = null;
    observedNovelStatus = null;
    if (taskPollTimer !== null) {
        clearInterval(taskPollTimer);
        taskPollTimer = null;
    }
}

function pollNovelTask() {
    const settings = activeSettings;
    if (!settings) {
        return;
    }
    const statusNode = document.getElementById(NOVEL_STATUS_ELEMENT_ID);
    if (statusNode !== observedNovelStatus) {
        novelStatusObserver?.disconnect();
        observedNovelStatus = statusNode;
        novelStatusObserver = statusNode ? new MutationObserver(pollNovelTask) : null;
        novelStatusObserver?.observe(statusNode, { attributes: true, attributeFilter: ['class'] });
    }


    const guarded = settings.guardNovelTask !== false;
    const running = guarded && isNovelTaskRunning();

    if (running === novelTaskRunning) {
        return;
    }

    novelTaskRunning = running;

    if (running) {
        asleep = false;
        addHold('novel-task');
        noteActivity();
        if (!settings.enabled) {
            // 总开关关着时只记录状态，不改文案：否则会出现「已关闭」被覆盖成「已开启」。
            renderDiagnostics();
            return;
        }
        void engage(settings);
        setStatus('屏幕常亮已开启 · 正在守护小说生成任务（任务结束前不会自动放开）。', 'active');
        renderDiagnostics();
        return;
    }

    removeHold('novel-task');

    if (!extensionActive || !settings.enabled) {
        renderDiagnostics();
        return;
    }

    if (isNovelTaskPaused()) {
        // 暂停 = 不产生网络请求，没必要继续烧屏幕；恢复任务时轮询会自动唤醒。
        armIdleTimer();
        setStatus(`小说任务已暂停，屏幕常亮仍开启（${idleHint()}，继续任务会自动恢复守护）。`, 'active');
    } else if (Date.now() - lastActivityAt > TASK_END_GRACE_MS) {
        sleepNow('task-ended');
    } else {
        armIdleTimer();
        setStatus(`小说生成任务已结束，屏幕常亮仍开启（${idleHint()}）。`, 'active');
    }

    renderDiagnostics();
}

function isNovelTaskPaused() {
    const node = document.getElementById(NOVEL_STATUS_ELEMENT_ID);
    return node?.classList?.contains?.('paused') === true;
}

function idleHint() {
    const minutes = Number(activeSettings?.idleTimeoutMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
        return '不会自动放开';
    }
    return `${formatMinutes(minutes)}无操作后自动放开`;
}

function bindGenerationEvents() {
    if (generationSubscriptions.length) {
        return;
    }

    const context = globalThis.SillyTavern?.getContext?.();
    const eventSource = context?.eventSource;
    if (!eventSource || typeof eventSource.on !== 'function') {
        return;
    }

    // 酒馆自身生成期间也视为「有活要干」：否则把自定义时长设得很短时，长回复会被中途放开。
    const subscribe = (name, handler) => {
        eventSource.on(name, handler);
        generationSubscriptions.push(() => eventSource.removeListener(name, handler));
    };
    if (typeof eventSource.removeListener !== 'function') {
        return;
    }
    subscribe('generation_started', () => addHold('tavern-generation'));
    for (const name of ['generation_ended', 'generation_stopped']) {
        subscribe(name, () => {
            removeHold('tavern-generation');
            armIdleTimer();
        });
    }

}

function installPublicApi() {
    if (publicApiInstalled) {
        return;
    }

    globalThis.SillyDroidScreenAwake = {
        /** 其它插件可以显式按住屏幕常亮，直到 release。 */
        hold: (reason = 'external') => {
            addHold(`external:${reason}`);
            return hasHeldWork();
        },
        release: (reason = 'external') => {
            removeHold(`external:${reason}`);
            armIdleTimer();
            return hasHeldWork();
        },
        isHeld: () => hasHeldWork(),
        isNovelTaskRunning,
        getDiagnostics: () => ({
            visibility: document.visibilityState,
            holds: [...holds],
            videoRequested: wantsTaskVideo(),
            videoPaused: keepAwakeVideo?.paused ?? true,
            videoTime: keepAwakeVideo?.currentTime ?? null,
            lastVideoProgressAt,
            lastVideoError,
            audioPaused: taskAudio?.paused ?? true,
            lastAudioError,
        }),
        wake: () => {
            asleep = false;
            noteActivity();
        },
    };

    publicApiInstalled = true;
}

function uninstallPublicApi() {
    if (publicApiInstalled) {
        delete globalThis.SillyDroidScreenAwake;
        publicApiInstalled = false;
    }
}

function renderDiagnostics() {
    const node = document.getElementById(diagnosticsId);
    if (!node) {
        return;
    }

    const mark = (ok) => (ok ? '✓' : '✗');
    const novelStatus = novelTaskRunning
        ? '运行中'
        : (document.getElementById(NOVEL_STATUS_ELEMENT_ID) ? '空闲' : '未检测到');
    node.textContent = `环境自检：安全上下文 ${mark(isSecure())} · 唤醒锁 ${mark(isWakeLockSupported())} · 视频保活 ${mark(isVideoFallbackSupported())} · 任务 ${novelStatus} · 视频 ${keepAwakeVideo && !keepAwakeVideo.paused ? "播放中（后台效果待实测）" : "未播放"} · 音频 ${taskAudio && !taskAudio.paused ? "播放中" : "未播放"}${lastVideoError ? " · " + lastVideoError : ""}${lastAudioError ? " · 音频 " + lastAudioError : ""}`;
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
        if (!extensionActive || !settings.enabled || asleep || document.visibilityState !== 'visible') {
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
    } else if (asleep) {
        // 主动休眠时由 sleepNow() 负责文案，避免被「已关闭」覆盖。
        return;
    } else if (document.visibilityState !== 'visible') {
        // A screen lock release must not overwrite task-video status.
        if (!wantsTaskVideo()) {
            setStatus('酒馆在后台，屏幕常亮已暂停。返回酒馆后会自动恢复。', 'paused');
        }
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
            if (!extensionActive || !settings.enabled || asleep || document.visibilityState !== 'visible') {
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
// 此视频沿用前台防熄屏方案；后台任务另有可选静音音频辅助，效果依宿主而定。
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
        try {
            recorder.start();
        } catch {
            finish(null);
            return;
        }
        setTimeout(() => {
            try {
                recorder.stop();
            } catch {
                // Already stopped.
            }
        }, 300);
    }).finally(() => stream.getTracks().forEach((track) => track.stop()));

    if (!blob?.size) {
        return null;
    }

    return URL.createObjectURL(blob);
}

async function createAndPlayKeepAwakeVideo() {
    if (!isVideoFallbackSupported() || !document.body) {
        return false;
    }

    const revision = mediaRevision;
    let clipUrl;
    try {
        clipUrl = await createKeepAwakeClipUrl();
    } catch (error) {
        lastVideoError = error?.name ?? '视频创建失败';
        return false;
    }
    if (!clipUrl) {
        return false;
    }
    if (revision !== mediaRevision || !wantsVideo()) {
        URL.revokeObjectURL(clipUrl);
        return false;
    }
    keepAwakeClipUrl = clipUrl;

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
    video.addEventListener('timeupdate', () => {
        if (keepAwakeVideo === video) lastVideoProgressAt = Date.now();
    });
    video.addEventListener('error', () => {
        if (keepAwakeVideo === video) {
            lastVideoError = `媒体错误 ${video.error?.code ?? 'unknown'}`;
            renderDiagnostics();
        }
    });

    try {
        await video.play();
        if (revision !== mediaRevision || !wantsVideo()) {
            video.pause();
            return false;
        }
        lastVideoError = '';
    } catch (error) {
        lastVideoError = error?.name ?? '播放失败';
        console.debug(`[${extensionId}] keep-awake video could not play`, error);
        if (keepAwakeVideo === video) destroyKeepAwakeVideo();
        return false;
    }

    return true;
}

async function startKeepAwakeVideo() {
    if (keepAwakeVideoRequest) {
        return keepAwakeVideoRequest;
    }
    if (keepAwakeVideo) {
        const video = keepAwakeVideo;
        const revision = mediaRevision;
        if (video.error) {
            destroyKeepAwakeVideo();
            return false;
        }
        if (keepAwakeVideo.paused) {
            try {
                await video.play();
            } catch (error) {
                lastVideoError = error?.name ?? '播放失败';
                return false;
            }
        }
        if (revision !== mediaRevision || !wantsVideo()) {
            video.pause();
            return false;
        }
        lastVideoError = '';
        return keepAwakeVideo === video && !video.paused;
    }

    keepAwakeVideoRequest = createAndPlayKeepAwakeVideo();
    try {
        return await keepAwakeVideoRequest;
    } finally {
        keepAwakeVideoRequest = null;
    }
}

// A local PCM WAV with an actual audio track. No microphone or network access.
function syncTaskAudio() {
    if (!wantsTaskVideo() || activeSettings.taskSilentAudio === false) {
        stopTaskAudio();
        return;
    }
    if (audioPlayPending || (taskAudio && !taskAudio.paused)) return;
    if (Date.now() - lastAudioAttemptAt < ENGAGE_FAILURE_COOLDOWN_MS) return;
    lastAudioAttemptAt = Date.now();
    if (!taskAudio) {
        const bytes = new Uint8Array(44 + 8000 * 2);
        const view = new DataView(bytes.buffer);
        const write = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
        write(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true);
        write(8, 'WAVE'); write(12, 'fmt '); view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, 8000, true); view.setUint32(28, 16000, true);
        view.setUint16(32, 2, true); view.setUint16(34, 16, true);
        write(36, 'data'); view.setUint32(40, bytes.length - 44, true);
        taskAudioUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
        taskAudio = document.createElement('audio');
        taskAudio.loop = true;
        taskAudio.src = taskAudioUrl;
        taskAudio.setAttribute('aria-hidden', 'true');
        document.body.append(taskAudio);
    }
    const audio = taskAudio;
    audioPlayPending = true;
    Promise.resolve().then(() => audio.play()).then(() => {
        if (taskAudio !== audio || !wantsTaskVideo() || activeSettings?.taskSilentAudio === false) {
            audio.pause();
        } else {
            lastAudioError = '';
        }
    }).catch(error => {
        if (taskAudio === audio) lastAudioError = error?.name ?? '播放失败';
    }).finally(() => {
        if (taskAudio === audio) audioPlayPending = false;
        renderDiagnostics();
    });
}

function stopTaskAudio() {
    if (taskAudio) {
        taskAudio.pause();
        taskAudio.removeAttribute('src');
        taskAudio.load();
        taskAudio.remove();
        taskAudio = null;
    }
    if (taskAudioUrl) URL.revokeObjectURL(taskAudioUrl);
    taskAudioUrl = null;
    audioPlayPending = false;
    lastAudioAttemptAt = 0;
}

function pauseKeepAwakeVideo() {
    mediaRevision++;
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
    mediaRevision++;
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
// 调度：任务媒体独立于前台屏幕唤醒锁
// ---------------------------------------------------------------------------

function wantsTaskVideo() {
    return extensionActive && activeSettings?.enabled === true
        && activeSettings.backgroundTaskVideo !== false && hasHeldWork();
}

function wantsVideo() {
    return wantsTaskVideo() || wantsKeepAwake();
}

async function engage(settings) {
    if (!extensionActive || !settings.enabled || asleep) return;

    // Start media before awaiting the screen lock, while the page is still visible.
    if (wantsTaskVideo()) {
        syncTaskAudio();
        const playing = await startKeepAwakeVideo();
        if (!wantsTaskVideo()) return;
        syncTaskAudio();
        if (document.visibilityState === 'visible') {
            await tryWakeLock(settings);
        } else {
            void releaseWakeLock();
        }
        if (!wantsTaskVideo()) return;
        lastEngageFailedAt = playing ? 0 : Date.now();
        setMode(playing ? MODE_VIDEO : MODE_NONE);
        setStatus(playing
            ? '任务媒体已启动 · 切换后台时继续保留，实际后台运行效果请实测。'
            : '任务媒体未能播放；任务仍保持守护，返回前台触摸后可重试。', playing ? 'active' : 'warning');
        renderDiagnostics();
        return;
    }

    stopTaskAudio();
    if (!wantsKeepAwake()) {
        pauseKeepAwakeVideo();
        void releaseWakeLock();
        setMode(MODE_NONE);
        setStatus('酒馆在后台，当前没有任务媒体守护。', 'paused');
        return;
    }
    const locked = await tryWakeLock(settings);
    if (!wantsKeepAwake() || wantsTaskVideo()) return;
    if (locked) {
        destroyKeepAwakeVideo();
        lastEngageFailedAt = 0;
        setMode(MODE_WAKE_LOCK);
        setStatus('屏幕常亮已开启（系统唤醒锁）。', 'active');
    } else {
        const playing = await startKeepAwakeVideo();
        if (!wantsKeepAwake() || wantsTaskVideo()) return;
        lastEngageFailedAt = playing ? 0 : Date.now();
        setMode(playing ? MODE_VIDEO : MODE_NONE);
        setStatus(playing ? '屏幕常亮已开启（静音视频）。' : '当前环境无法播放常亮视频。', playing ? 'active' : 'unsupported');
    }
    renderDiagnostics();
}

// ---------------------------------------------------------------------------
// 最后一层筛子：对账/自愈
//
// 上面所有判断都是事件驱动的，事件丢了（visibilitychange 没来、锁被悄悄回收、
// 计时器没被武装）就会停在错误状态。这一层每 5 秒重算一次「应该保活吗」，
// 与「实际在保活吗」比对，不一致就纠正——不依赖任何单个事件。
// ---------------------------------------------------------------------------

function wantsKeepAwake() {
    return extensionActive
        && activeSettings?.enabled === true
        && document.visibilityState === 'visible'
        && !asleep;
}

function isKeepingAwake() {
    if (keepAwakeVideo && !keepAwakeVideo.paused) {
        return true;
    }
    return Boolean(wakeLockSentinel && !wakeLockSentinel.released);
}

function needsIdleTimer() {
    const minutes = Number(activeSettings?.idleTimeoutMinutes);
    return extensionActive
        && activeSettings?.enabled === true
        && !asleep
        && !hasHeldWork()
        && Number.isFinite(minutes)
        && minutes > 0;
}

function reconcile() {
    if (!extensionActive || !activeSettings) {
        return;
    }

    if (!wantsKeepAwake() && !wantsTaskVideo()) {
        pauseKeepAwakeVideo();
        stopTaskAudio();
        void releaseWakeLock();
        setMode(MODE_NONE);
    } else {
        const videoNeeded = wantsTaskVideo();
        const videoPlaying = keepAwakeVideo && !keepAwakeVideo.paused && !keepAwakeVideo.error;
        if ((videoNeeded && !videoPlaying) || (!videoNeeded && !isKeepingAwake())) {
            if (Date.now() - lastEngageFailedAt >= ENGAGE_FAILURE_COOLDOWN_MS) {
                void engage(activeSettings);
            }
        }
        if (videoNeeded) syncTaskAudio();
        if (document.visibilityState !== 'visible') void releaseWakeLock();
    }
    renderDiagnostics();

    // 计时器兜底：本该在计数却没有计时器（例如唤醒时漏了武装），补一个。
    if (needsIdleTimer() && idleTimer === null) {
        armIdleTimer();
    }
}

function startReconcile() {
    if (reconcileTimer !== null) {
        return;
    }
    reconcileTimer = setInterval(() => {
        try {
            reconcile();
        } catch (error) {
            console.warn(`[${extensionId}] reconciler failed`, error);
        }
    }, RECONCILE_INTERVAL_MS);
}

function stopReconcile() {
    if (reconcileTimer !== null) {
        clearInterval(reconcileTimer);
        reconcileTimer = null;
    }
}

// ---------------------------------------------------------------------------
// 界面与生命周期
// ---------------------------------------------------------------------------

function clampIdle(value) {
    const minutes = Number(value);
    if (!Number.isFinite(minutes) || minutes < 0) {
        return defaults.idleTimeoutMinutes;
    }
    return Math.min(MAX_IDLE_MINUTES, Math.round(minutes * 100) / 100);
}

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
            <div class="sillydroid-screen-awake-row">
                <label for="${dimSliderId}">页面压暗</label>
                <input id="${dimSliderId}" type="range" min="0" max="${MAX_DIM_PERCENT}" step="5" />
                <output id="${dimValueId}">0%</output>
            </div>
            <div class="sillydroid-screen-awake-row">
                <label for="${idleInputId}">无操作自动放开（分钟，0=不放开）</label>
                <input id="${idleInputId}" type="number" min="0" max="${MAX_IDLE_MINUTES}" step="1" />
            </div>
            <label class="checkbox_label sillydroid-screen-awake-toggle" for="${guardCheckboxId}">
                <input id="${guardCheckboxId}" type="checkbox" />
                <span>与小说自动生成器联动（任务运行期间不放开）</span>
            </label>
            <label class="checkbox_label sillydroid-screen-awake-toggle" for="${backgroundCheckboxId}">
                <input id="${backgroundCheckboxId}" type="checkbox" />
                <span>任务期间持续播放视频（尝试保持后台运行）</span>
            </label>
            <label class="checkbox_label sillydroid-screen-awake-toggle" for="${audioCheckboxId}">
                <input id="${audioCheckboxId}" type="checkbox" />
                <span>同时播放静音音频辅助保活</span>
            </label>
            <p class="sillydroid-screen-awake-description">
                任务开始时启动本地循环媒体，切后台后继续保留；整个任务完成、暂停或停止后释放。
                暂时断网和重试期间继续守护。不同手机的后台运行效果需要实测；总开关可随时停止媒体。
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
            asleep = false;
            await engage(settings);
            armIdleTimer();
        } else {
            clearIdleTimer();
            pauseKeepAwakeVideo();
            destroyKeepAwakeVideo();
            stopTaskAudio();
            await releaseWakeLock();
            setMode(MODE_NONE);
            setStatus('屏幕常亮已关闭。', 'off');
        }
    });

    for (const [id, key] of [[backgroundCheckboxId, 'backgroundTaskVideo'], [audioCheckboxId, 'taskSilentAudio']]) {
        const input = document.getElementById(id);
        input.checked = settings[key] !== false;
        input.addEventListener('change', () => {
            settings[key] = input.checked;
            context.saveSettingsDebounced();
            if (settings.enabled) void engage(settings);
            renderDiagnostics();
        });
    }

    const dimSlider = document.getElementById(dimSliderId);
    dimSlider.value = String(clampDim(settings.dimLevel));
    dimSlider.addEventListener('input', () => {
        settings.dimLevel = clampDim(dimSlider.value);
        context.saveSettingsDebounced();
        applyDim(settings.dimLevel);
    });

    const idleInput = document.getElementById(idleInputId);
    idleInput.value = String(clampIdle(settings.idleTimeoutMinutes));
    idleInput.addEventListener('change', () => {
        settings.idleTimeoutMinutes = clampIdle(idleInput.value);
        idleInput.value = String(settings.idleTimeoutMinutes);
        context.saveSettingsDebounced();
        armIdleTimer();
    });

    const guardCheckbox = document.getElementById(guardCheckboxId);
    guardCheckbox.checked = settings.guardNovelTask !== false;
    guardCheckbox.addEventListener('change', () => {
        settings.guardNovelTask = guardCheckbox.checked;
        context.saveSettingsDebounced();
        if (!guardCheckbox.checked) {
            removeHold('novel-task');
            novelTaskRunning = false;
            armIdleTimer();
            renderDiagnostics();
        } else {
            pollNovelTask();
        }
    });

    applyDim(settings.dimLevel);
    renderDiagnostics();
    installPublicApi();
    bindGenerationEvents();
    startNovelTaskPolling();
    startReconcile();

    if (settings.enabled) {
        void engage(settings);
        armIdleTimer();
    } else {
        setStatus('默认关闭。开启后前台保持常亮，任务期间尝试持续播放后台媒体。', 'off');
    }

    if (!activityHandlers) {
        const onActivity = () => noteActivity();
        activityHandlers = {
            pointerdown: onActivity,
            keydown: onActivity,
            wheel: onActivity,
            touchstart: onActivity,
            scroll: onActivity,
        };
        for (const [type, handler] of Object.entries(activityHandlers)) {
            document.addEventListener(type, handler, { passive: true, capture: true });
        }
    }

    visibilityChangeHandler = () => {
        if (!extensionActive) {
            return;
        }

        if (document.visibilityState === 'visible') {
            if (settings.enabled) {
                asleep = false;
                noteActivity();
                void engage(settings);
            }
            return;
        }

        // Preserve existing media while hidden; no screen lock is requested here.
        if (wantsTaskVideo()) {
            void engage(settings);
        } else {
            pauseKeepAwakeVideo();
            stopTaskAudio();
            if (settings.enabled) setStatus('酒馆在后台，当前没有任务媒体守护。', 'paused');
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
            // A BFCache page must release resources; on pageshow it may resume.
            // Ordinary APP backgrounding is handled by visibilitychange.
            pauseKeepAwakeVideo();
            stopTaskAudio();
            void releaseWakeLock();
        };
        window.addEventListener('pagehide', pageHideHandler);
    }
    if (!pageShowHandler) {
        pageShowHandler = () => {
            initializeExtension();
            if (activeSettings?.enabled && !asleep) {
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

    if (activityHandlers) {
        for (const [type, handler] of Object.entries(activityHandlers)) {
            document.removeEventListener(type, handler, { capture: true });
        }
        activityHandlers = null;
    }

    if (pageHideHandler) {
        window.removeEventListener('pagehide', pageHideHandler);
        pageHideHandler = null;
    }
    if (pageShowHandler) {
        window.removeEventListener('pageshow', pageShowHandler);
        pageShowHandler = null;
    }

    for (const unsubscribe of generationSubscriptions.splice(0)) unsubscribe();
    stopNovelTaskPolling();
    stopReconcile();
    clearIdleTimer();
    lastEngageFailedAt = 0;
    holds.clear();
    novelTaskRunning = false;
    asleep = false;
    uninstallPublicApi();
    removeDim();
    destroyKeepAwakeVideo();
    stopTaskAudio();
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

