/** 通用工具函数 */

/** 把酷狗图片 URL 中的 {size} 占位符替换为具体尺寸 */
export function fixImgUrl(url, size) {
  if (!url || typeof url !== 'string') return '';
  return url.replace('{size}', String(size));
}

/** 秒 → "mm:ss";undefined/null → "--:--" */
export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '--:--';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** HTML 转义:所有用户/接口数据插入 DOM 前必须经过这里 */
export function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** 封面占位(数据 URI SVG,渐变底 + 音符) */
export const PLACEHOLDER_IMG =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240">
       <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
         <stop offset="0" stop-color="#2b2f55"/><stop offset="1" stop-color="#141731"/>
       </linearGradient></defs>
       <rect width="240" height="240" fill="url(#g)"/>
       <text x="50%" y="54%" font-size="72" text-anchor="middle" dominant-baseline="middle">🎵</text>
     </svg>`
  );
