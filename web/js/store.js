/**
 * 队列持久化(localStorage):防抖保存 + 加载校验(上限 500 条、7 天过期、静默失败)。
 */
import { CONFIG } from './config.js';
import { debounce } from './utils.js';

let pending = { items: [], index: -1 };

const flush = debounce(() => {
  try {
    localStorage.setItem(
      CONFIG.QUEUE_STORAGE_KEY,
      JSON.stringify({ items: pending.items, index: pending.index, savedAt: Date.now() })
    );
  } catch {
    /* 存储不可用时静默降级 */
  }
}, 500);

export function saveQueue(items, index) {
  pending = { items: items.slice(0, CONFIG.MAX_QUEUE_ITEMS), index };
  flush();
}

export function loadQueue() {
  try {
    const raw = localStorage.getItem(CONFIG.QUEUE_STORAGE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!Array.isArray(d.items) || !d.items.length) return null;
    if (Date.now() - (d.savedAt || 0) > CONFIG.QUEUE_MAX_AGE_MS) return null;
    const items = d.items.filter(
      (s) => s && typeof s.name === 'string' &&
        ((typeof s.hash === 'string' && s.hash) ||
         (typeof s.localId === 'string' && s.localId))
    );
    if (!items.length) return null;
    return { items, index: Number.isInteger(d.index) ? d.index : 0 };
  } catch {
    return null;
  }
}
