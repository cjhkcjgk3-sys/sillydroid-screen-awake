# SillyDroid 屏幕常亮

一个独立的 SillyTavern 前端扩展。启用后通过浏览器 Screen Wake Lock API 阻止酒馆页面前台运行时自动熄屏。

## 安装

在 SillyTavern 的扩展管理页选择从 URL 安装，并填入：

```text
https://github.com/cjhkcjgk3-sys/sillydroid-screen-awake.git
```

安装后刷新页面，在扩展设置里打开“保持屏幕常亮”。也可以把整个仓库目录复制到：

```text
public/scripts/extensions/third-party/sillydroid-screen-awake/
```

## 说明

- 默认关闭，开关状态保存在 SillyTavern 扩展设置里。
- 只申请屏幕唤醒锁；不会创建或播放视频、音频，也不修改生成、消息和网络请求逻辑。
- 酒馆页面进入后台时释放唤醒锁，返回前台后重新申请。
- 当前浏览器不支持或拒绝唤醒锁时，扩展会显示状态，不会改变酒馆行为。
- 常亮会增加耗电；它不能阻止 Android 其他省电策略中断网络。

本扩展按 `SillyTavern.getContext()` 提供扩展设置接口，并在运行时探测 `navigator.wakeLock`。未对特定 SillyTavern 版本或设备完成运行时验收。

## 许可证

本仓库沿用 SillyDroid 项目的 PolyForm Noncommercial License 1.0.0，见 [LICENSE](LICENSE)。
