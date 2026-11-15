# SillyDroid 屏幕常亮

一个独立的 SillyTavern 前端扩展。启用后阻止酒馆页面在前台运行时自动熄屏，效果类似正在播放视频。

## 安装

在 SillyTavern 的扩展管理页选择从 URL 安装，并填入：

```text
https://github.com/cjhkcjgk3-sys/sillydroid-screen-awake.git
```

安装后刷新页面，在扩展设置里打开“保持屏幕常亮”。也可以把整个仓库目录复制到：

```text
public/scripts/extensions/third-party/sillydroid-screen-awake/
```

## 两档保活策略

1. **系统屏幕唤醒锁（优先）**：`navigator.wakeLock.request('screen')`。这是浏览器提供的正规接口，几乎不耗电。
2. **静音视频保活（兜底）**：唤醒锁不可用时，扩展在页面角落放一个 2×2 像素、无声音、循环播放的极小视频。浏览器会把“正在播放带视频轨的媒体”视为播放视频，从而推迟熄屏——这正是 NoSleep.js 等库多年使用的方式。**纯音频不行**，系统只在乎有没有视频轨。

面板底部会显示环境自检：`安全上下文 / 唤醒锁 / 视频保活` 三项是否可用，以及当前生效的是哪一档。

> 仅当唤醒锁不可用（例如通过局域网 `http://192.168.x.x` 访问、非安全上下文）时才启用视频保活，避免不必要的解码耗电。

## 重要限制

- **唤醒锁只在安全上下文可用**：`http://localhost` / `127.0.0.1` 或 HTTPS。用手机通过 `http://局域网IP:8000` 访问酒馆时 `navigator.wakeLock` 不存在，扩展会自动退回视频保活。
- **视频保活的生效依赖浏览器实现**：Chrome 等 Chromium 内核浏览器会因视频播放而保持亮屏；如果把酒馆套在自研 WebView 里，宿主应用必须自己转发 `FLAG_KEEP_SCREEN_ON`（或调用 `webView.setKeepScreenOn(true)`），Web 层无法强制。这种情况下自检可能会显示“视频保活 ✓”但屏幕仍会熄灭，需要宿主适配或在浏览器里访问。
- 页面进入后台（切标签、按电源键锁屏）时两者都会释放，这是系统要求；返回前台后自动恢复。
- 常亮会增加耗电；它不能阻止 Android 其他省电策略中断网络。

## 说明

- 默认关闭，开关状态保存在 SillyTavern 扩展设置里。
- 不创建音频、不改变酒馆的生成、消息和网络请求逻辑。
- 视频保活用的片段是运行时用 `canvas.captureStream()` + `MediaRecorder` 现场录制的 16×16 无声 WebM，仓库里不附带任何二进制素材。
- 当前浏览器三项能力都不可用时，扩展会显示明确状态，不改变酒馆行为。

本扩展按 `SillyTavern.getContext()` 提供扩展设置接口，并在运行时探测 `navigator.wakeLock` 与媒体播放能力。未对特定 SillyTavern 版本或设备完成运行时验收。

## 许可证

本仓库沿用 SillyDroid 项目的 PolyForm Noncommercial License 1.0.0，见 [LICENSE](LICENSE)。
