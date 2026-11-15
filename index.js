const extensionId = 'sillydroid-screen-awake';
const panelId = 'sillydroid-screen-awake-panel';
const checkboxId = 'sillydroid-screen-awake-enabled';
const statusId = 'sillydroid-screen-awake-status';
const defaults = { enabled: false };

let wakeLockSentinel = null;
let wakeLockRequest = null;
let extensionActive = true;
let mountObserver = null;
let visibilityChangeHandler = null;
let pageHideHandler = null;
let pageShowHandler = null;
let activeSettings = null;

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

async function releaseWakeLock() {
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
    if (wakeLockSentinel === sentinel) {
        wakeLockSentinel = null;
    }

    if (!extensionActive) {
        return;
    }

    if (!settings.enabled) {
        setStatus('屏幕常亮已关闭。', 'off');
    } else if (document.visibilityState !== 'visible') {
        setStatus('酒馆在后台，屏幕唤醒锁已暂停。返回酒馆后会重新申请。', 'paused');
    } else {
        setStatus('系统已释放屏幕唤醒锁。开关仍开启，可以关闭后再打开重试。', 'warning');
    }
}

async function acquireWakeLock(settings) {
    if (!extensionActive || !settings.enabled) {
        return;
    }

    if (document.visibilityState !== 'visible') {
        setStatus('酒馆在后台，返回酒馆后会申请屏幕唤醒锁。', 'paused');
        return;
    }

    const wakeLock = navigator.wakeLock;
    if (!wakeLock || typeof wakeLock.request !== 'function') {
        setStatus('当前浏览器不支持屏幕唤醒锁。酒馆功能不受影响。', 'unsupported');
        return;
    }

    if (wakeLockSentinel && !wakeLockSentinel.released) {
        setStatus('屏幕常亮已开启。', 'active');
        return;
    }

    if (wakeLockRequest) {
        return wakeLockRequest;
    }

    setStatus('正在申请屏幕唤醒锁…', 'pending');
    wakeLockRequest = (async () => {
        try {
            const sentinel = await wakeLock.request('screen');
            if (!extensionActive || !settings.enabled || document.visibilityState !== 'visible') {
                await sentinel.release();
                return;
            }

            wakeLockSentinel = sentinel;
            sentinel.addEventListener('release', () => onWakeLockReleased(sentinel, settings), { once: true });
            setStatus('屏幕常亮已开启。酒馆页面保持前台时，屏幕不会按系统超时自动关闭。', 'active');
        } catch (error) {
            const detail = error?.name === 'NotAllowedError'
                ? '浏览器或系统拒绝了屏幕唤醒锁申请。'
                : '屏幕唤醒锁申请失败。';
            setStatus(`${detail}可以关闭后再打开开关重试。`, 'error');
        } finally {
            wakeLockRequest = null;
        }
    })();

    return wakeLockRequest;
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
            <p class="sillydroid-screen-awake-description">
                仅在酒馆页面位于前台时阻止屏幕自动关闭。不会播放视频或音频，也不改变酒馆的生成、消息和网络请求。
            </p>
            <p id="${statusId}" class="sillydroid-screen-awake-status" role="status" aria-live="polite"></p>
        </div>`;
    settingsRoot.append(panel);

    const checkbox = document.getElementById(checkboxId);
    checkbox.checked = settings.enabled === true;
    checkbox.addEventListener('change', async () => {
        settings.enabled = checkbox.checked;
        context.saveSettingsDebounced();

        if (settings.enabled) {
            await acquireWakeLock(settings);
        } else {
            await releaseWakeLock();
            setStatus('屏幕常亮已关闭。', 'off');
        }
    });

    if (settings.enabled) {
        void acquireWakeLock(settings);
    } else {
        setStatus('默认关闭。开启后，屏幕只在酒馆页面前台时保持常亮。', 'off');
    }

    visibilityChangeHandler = () => {
        if (!extensionActive) {
            return;
        }

        if (document.visibilityState === 'visible') {
            if (settings.enabled) {
                void acquireWakeLock(settings);
            }
            return;
        }

        if (settings.enabled) {
            setStatus('酒馆在后台，屏幕唤醒锁已暂停。返回酒馆后会重新申请。', 'paused');
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
            void releaseWakeLock();
        };
        window.addEventListener('pagehide', pageHideHandler);
    }
    if (!pageShowHandler) {
        pageShowHandler = () => {
            initializeExtension();
            if (activeSettings?.enabled) {
                void acquireWakeLock(activeSettings);
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
        console.error(`[${extensionId}] Failed to initialize`, error);
        return;
    }

    if (mountObserver) {
        return;
    }

    mountObserver = new MutationObserver(() => {
        try {
            if (mountExtension()) {
                mountObserver.disconnect();
                mountObserver = null;
            }
        } catch (error) {
            console.error(`[${extensionId}] Failed to initialize`, error);
            mountObserver.disconnect();
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

    void releaseWakeLock();
    activeSettings = null;
    document.getElementById(panelId)?.remove();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeExtension, { once: true });
} else {
    initializeExtension();
}
