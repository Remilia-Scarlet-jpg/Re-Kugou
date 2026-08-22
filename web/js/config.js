/**
 * 可注入配置。
 * 未来 Electron 壳只需在加载页面脚本前设置 window.__APP_CONFIG__ 即可覆盖。
 */
export const CONFIG = Object.assign(
  {
    API_BASE: 'http://localhost:3000', // 酷狗 API(app_win.exe)
    URL_API: '/api/url',               // 播放地址解析(本服务同源代理)
    PLAYLIST_API: '/api/playlist',     // 歌单曲目(本服务同源代理 m.kugou 老接口)
    IMG_SIZE_CARD: 480,                // 卡片封面尺寸
    IMG_SIZE_ROW: 240,                 // 列表行封面尺寸
    QUEUE_STORAGE_KEY: 'vmp.queue.v1', // 队列持久化键
    MAX_QUEUE_ITEMS: 500,
    QUEUE_MAX_AGE_MS: 7 * 24 * 3600 * 1000, // 持久化队列 7 天过期
  },
  window.__APP_CONFIG__ || {}
);
