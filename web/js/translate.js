/**
 * AI 歌词翻译(前端侧)。
 *
 * 为什么需要:酷狗接口对外文歌**不一定带中文译文**(实测很多日文歌只给原语言),
 * 所以按需请求同源 POST /api/translate,由本地服务调 LLM 翻译(key 只留在服务端)。
 * 译文按歌曲 hash 缓存进 localStorage,重播不再重复花钱。
 *
 * 存储:`vmp.lyricTrans.v1` = `{ on: boolean, cache: { "<hash>": ["行1译文", ...] } }`
 * 失败一律静默降级(返回 {ok:false, reason}),绝不打断播放。
 */
const STORE_KEY = 'vmp.lyricTrans.v1';
const CACHE_MAX = 40; // 最多缓存 40 首(对象键顺序 = 写入顺序,超了丢最旧的)
const CHUNK = 150; // 单次请求行数上限(与服务端 TRANSLATE_MAX_LINES 对齐)

const KANA_RE = /[\u3040-\u30ff]/;
const CJK_RE = /[\u3400-\u9fff]/;
const FOREIGN_RE = /[A-Za-z\uAC00-\uD7AF\u0400-\u04FF]/;

function readStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return { on: !!raw.on, cache: raw.cache && typeof raw.cache === 'object' ? raw.cache : {} };
  } catch {
    return { on: false, cache: {} };
  }
}

function writeStore(s) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* 配额满就只保留内存态,cache 丢了重翻即可 */
  }
}

export function isTransOn() {
  return readStore().on;
}

export function setTransOn(on) {
  const s = readStore();
  s.on = !!on;
  writeStore(s);
}

/**
 * 是否需要翻译:中文歌词跳过 —— 既不浪费额度,也避免「中文翻中文」把歌词翻坏。
 * 判据:去掉「词:xxx」这类署名行后,有明显外文行、且中文行占比 < 75% 才翻。
 */
export function needsTranslation(texts) {
  const rows = (texts || []).filter((t) => t && !/[:：]/.test(t));
  if (rows.length < 2) return false;
  let cjk = 0;
  let foreign = 0;
  for (const t of rows) {
    if (KANA_RE.test(t)) {
      foreign++;
    } else if (CJK_RE.test(t)) {
      cjk++;
    } else if (FOREIGN_RE.test(t)) {
      foreign++;
    }
  }
  if (!foreign) return false;
  return cjk / rows.length < 0.75;
}

export function getCached(hash) {
  if (!hash) return null;
  const hit = readStore().cache[hash];
  return Array.isArray(hit) ? hit : null;
}

export function clearCached(hash) {
  if (!hash) return;
  const s = readStore();
  delete s.cache[hash];
  writeStore(s);
}

/**
 * 翻译整首歌的歌词(命中缓存直接返回)。
 * @returns {Promise<{ok:boolean, translations?:string[], reason?:string, cached?:boolean}>}
 */
export async function translateLines(song, lines) {
  const texts = (lines || []).map((t) => String(t || ''));
  if (!texts.length) return { ok: false, reason: 'empty' };
  const hash = song?.hash;
  const cached = getCached(hash);
  if (cached && cached.length >= texts.length) {
    return { ok: true, translations: cached.slice(0, texts.length), cached: true };
  }

  const out = [];
  for (let i = 0; i < texts.length; i += CHUNK) {
    const slice = texts.slice(i, i + CHUNK);
    let r = null;
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          song: song ? `${song.name || ''} - ${song.artists || ''}` : '',
          lines: slice,
        }),
      });
      r = await res.json();
    } catch {
      return { ok: false, reason: 'network' };
    }
    if (!r?.ok) return { ok: false, reason: r?.reason || 'error' };
    out.push(...(r.translations || []));
  }

  if (hash) {
    const s = readStore();
    s.cache[hash] = out;
    const keys = Object.keys(s.cache);
    while (keys.length > CACHE_MAX) delete s.cache[keys.shift()];
    writeStore(s);
  }
  return { ok: true, translations: out };
}

// ---------- 密钥配置(读写本机服务;页面永远拿不到明文,只拿掩码) ----------

/** GET /api/llm-key → {configured, masked, source, file} */
export async function getKeyStatus() {
  try {
    const r = await fetch('/api/llm-key', { headers: { Accept: 'application/json' } });
    const d = await r.json();
    return d?.ok === false ? { configured: false, masked: '', source: '' } : d;
  } catch {
    return { configured: false, masked: '', source: '', offline: true };
  }
}

async function postKey(payload) {
  try {
    const r = await fetch('/api/llm-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await r.json();
  } catch {
    return { ok: false, error: '无法连接本地服务' };
  }
}

/** 保存新密钥(写进密钥文件并立刻生效) */
export const saveKey = (key) => postKey({ key: String(key || '').trim() });

/** 清空密钥(删密钥文件;若密钥来自环境变量则删不掉,会回 envLocked:true) */
export const clearKey = () => postKey({ key: '' });

/** 把当前正在用的密钥(例如来自环境变量)落到密钥文件里 */
export const persistKey = () => postKey({ action: 'persist' });
