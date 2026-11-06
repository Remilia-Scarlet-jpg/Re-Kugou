/**
 * 运行平台识别(Android 移植入口):只做三件事,不改任何业务逻辑。
 *   1. 给 <html> 打 data-platform("android" | "web"),供 CSS 分流
 *   2. 暴露 window.__APP_PLATFORM / __APP_CAPACITOR 给回归测试
 *   3. 手机上没有"悬停"、控件更小,由 CSS 统一处理,不在 JS 里散落判断
 *
 * 判定顺序:Capacitor 原生壳(window.Capacitor.isNativePlatform())→ UA 含 Android → web。
 * 注意:Android 版 WebView 加载的就是 http://localhost:3001(与桌面开发同源),
 * 所以**不能**用 URL 判断平台,只能看 Capacitor 注入或 UA。
 */
const cap = typeof window.Capacitor?.isNativePlatform === 'function'
  ? window.Capacitor.isNativePlatform()
  : false;
const android = cap || /Android/i.test(navigator.userAgent || '');

document.documentElement.dataset.platform = android ? 'android' : 'web';
window.__APP_PLATFORM = android ? 'android' : 'web';
window.__APP_CAPACITOR = cap ? '1' : '0';
