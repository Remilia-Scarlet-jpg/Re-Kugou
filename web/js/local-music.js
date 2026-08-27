/**
 * 本地歌曲库:IndexedDB(vmp-localmusic-v1:audio 整文件 / cover APIC 封面)+
 * localStorage(vmp.localmusic.v1:歌曲元数据 + 歌单定义)+ objectURL 缓存。
 *
 * 依赖单向:仅 import ./id3.js,绝不 import player/ui(toast 由调用方发)。
 * 播放 URL 换歌时「先设新 src → 再 revoke 旧」;封面 URL 页面生命周期内不逐帧 revoke。
 * 测试标记:window.__APP_LOCAL(state 原地 mutate 稳定引用)/ __APP_LOCAL_API。
 */
import { readAudioMeta } from './id3.js';

const DB_NAME = 'vmp-localmusic-v1';
const STORE_AUDIO = 'audio';
const STORE_COVER = 'cover';
const META_KEY = 'vmp.localmusic.v1';
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 单文件上限 100MB

// ---------- 内存状态(localStorage 镜像,原地 mutate,__APP_LOCAL 引用稳定) ----------
const state = loadMeta();

function loadMeta() {
  try {
    const d = JSON.parse(localStorage.getItem(META_KEY) || 'null');
    if (d && Array.isArray(d.songs) && Array.isArray(d.playlists)) return d;
  } catch { /* 损坏忽略 */ }
  return { songs: [], playlists: [] };
}
function saveMeta() {
  try { localStorage.setItem(META_KEY, JSON.stringify(state)); } catch { /* 配额满忽略 */ }
}

// ---------- IndexedDB(vmp-localmusic-v1 / audio + cover) ----------
let db = null;
function openDb() {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_AUDIO)) req.result.createObjectStore(STORE_AUDIO);
      if (!req.result.objectStoreNames.contains(STORE_COVER)) req.result.createObjectStore(STORE_COVER);
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}
function idbPut(store, id, blob) {
  return openDb().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(store, 'readwrite');
    tx.objectStore(store).put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}
function idbGet(store, id) {
  return openDb().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  }));
}
function idbDelete(store, id) {
  return openDb().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}
function idbCount(store) {
  return openDb().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(store, 'readonly');
    const req = tx.objectStore(store).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

// ---------- objectURL 缓存 ----------
const playUrlCache = new Map(); // localId → objectURL(播放,换歌即 revoke)
const coverUrlCache = new Map(); // localId → objectURL(封面,页面生命周期)

function newLocalId() {
  let id;
  do {
    id = 'lm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  } while (state.songs.some((s) => s.localId === id));
  return id;
}

function normLocalSong(meta) {
  return {
    hash: '', localId: meta.localId, name: meta.name, artists: meta.artists,
    img: '', duration: meta.duration, size: meta.size, format: meta.format,
    local: true, cover: meta.cover,
  };
}

function dropSongRefs(localIds) {
  const set = new Set(localIds);
  for (const pl of state.playlists) pl.songIds = pl.songIds.filter((id) => !set.has(id));
}

// ---------- 导入 ----------
/** 逐个文件:ID3 解析 → 入 IDB → 写元数据。坏文件跳过不中断批量。
 *  返回 { songs: normLocalSong[], skipped: [{name, reason}] } */
export async function importFiles(fileList) {
  const files = Array.from(fileList || []);
  const songs = [];
  const skipped = [];
  for (const file of files) {
    if (!file || !file.size) continue;
    if (file.size > MAX_FILE_BYTES) {
      skipped.push({ name: file.name, reason: '文件过大(>100MB)' });
      continue;
    }
    try {
      const meta = await readAudioMeta(file);
      const localId = newLocalId();
      await idbPut(STORE_AUDIO, localId, file);
      if (meta.coverBlob) await idbPut(STORE_COVER, localId, meta.coverBlob);
      const entry = {
        localId, name: meta.name, artists: meta.artists, img: '',
        duration: null, size: file.size, format: meta.format,
        cover: !!meta.coverBlob, createdAt: Date.now(),
      };
      state.songs.push(entry);
      songs.push(normLocalSong(entry));
    } catch {
      skipped.push({ name: file.name, reason: '读取失败' });
    }
  }
  if (songs.length) saveMeta();
  return { songs, skipped };
}

// ---------- 查询 ----------
export function getSong(localId) {
  return state.songs.find((s) => s.localId === localId) || null;
}

export function getSongs(ids) {
  return (ids || []).map(getSong).filter(Boolean);
}

/** 队列持久化 shape(blob 在 IDB,仅存元数据) */
export function queueSongMeta(localId) {
  const s = getSong(localId);
  return s ? normLocalSong(s) : null;
}

// ---------- 播放 / 封面 URL ----------
export async function getPlayUrl(localId) {
  if (playUrlCache.has(localId)) return playUrlCache.get(localId);
  const blob = await idbGet(STORE_AUDIO, localId);
  if (!blob) throw new Error('audio blob missing');
  const url = URL.createObjectURL(blob);
  playUrlCache.set(localId, url);
  return url;
}

/** 仅当 url 是本模块创建的播放 URL 才 revoke(先设新 src 再调) */
export function releasePlayUrl(url) {
  for (const [id, u] of playUrlCache) {
    if (u === url) {
      URL.revokeObjectURL(u);
      playUrlCache.delete(id);
      return;
    }
  }
}

export async function getCoverUrl(localId) {
  if (coverUrlCache.has(localId)) return coverUrlCache.get(localId);
  const blob = await idbGet(STORE_COVER, localId);
  if (!blob) return '';
  const url = URL.createObjectURL(blob);
  coverUrlCache.set(localId, url);
  return url;
}

// ---------- 歌单 ----------
const CUSTOM_COVER_PREFIX = 'plc-'; // 自定义歌单封面在 cover store 的 key 前缀

export async function createPlaylist(name, songIds, songs) {
  const id = 'lp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const pl = {
    id, name,
    songIds: [...songIds],
    onlineSongs: [], // 在线歌内嵌条目(本地歌单可收录推荐/搜索的歌)
    img: '',         // 歌单级封面 URL(选在线歌封面时写此)
    customCover: false, // true = 封面来自上传图片(IDB plc-<id>)
    coverId: (songs || getSongs(songIds)).find((s) => s?.cover)?.localId || null,
    createdAt: Date.now(),
  };
  state.playlists.push(pl);
  saveMeta();
  return pl;
}

export function getPlaylists() {
  return [...state.playlists];
}

/** 歌单曲目(本地歌 + 在线歌混合;本地歌 lazy 展开,在线歌内嵌元数据) */
export function getPlaylistSongs(pl) {
  const locals = getSongs(pl?.songIds || []);
  const onlines = (pl?.onlineSongs || []).map((s) => ({
    hash: s.hash || '', hash320: s.hash320 || '', localId: '',
    name: s.name || '未知歌曲', artists: s.artists || '未知歌手',
    img: s.img || '', duration: s.duration, albumId: s.albumId || '', local: false,
  }));
  return [...locals, ...onlines];
}

/** 把一首歌加入本地歌单:本地歌 → songIds 引用(localId 去重);在线歌 → onlineSongs 内嵌(hash 去重) */
export function addSongToPlaylist(plId, song) {
  const pl = state.playlists.find((p) => p.id === plId);
  if (!pl || !song) return false;
  if (song.localId) {
    if (!pl.songIds.includes(song.localId)) pl.songIds.push(song.localId);
  } else if (song.hash) {
    if (!pl.onlineSongs) pl.onlineSongs = [];
    if (!pl.onlineSongs.some((s) => s.hash === song.hash)) {
      pl.onlineSongs.push({
        hash: song.hash, hash320: song.hash320 || '', name: song.name || '未知歌曲',
        artists: song.artists || '未知歌手', img: song.img || '', duration: song.duration,
        albumId: song.albumId || '', addedAt: Date.now(),
      });
    }
  } else {
    return false; // 无标识的歌(既非本地又无 hash)不收
  }
  saveMeta();
  return true;
}

/** 上传自定义封面:压缩后的 blob 存 IDB(plc-<id>),标记 customCover 并清歌单级 URL */
export async function setCustomCover(plId, blob) {
  const pl = state.playlists.find((p) => p.id === plId);
  if (!pl || !blob) return false;
  const key = CUSTOM_COVER_PREFIX + plId;
  await idbPut(STORE_COVER, key, blob);
  if (coverUrlCache.has(key)) { URL.revokeObjectURL(coverUrlCache.get(key)); coverUrlCache.delete(key); }
  pl.customCover = true;
  pl.img = '';
  saveMeta();
  return true;
}

/** 用歌单内某首歌的封面:本地歌 → coverId;在线歌 → 歌单级 img URL;清除自定义封面 */
export async function setPlaylistCoverFromSong(plId, song) {
  const pl = state.playlists.find((p) => p.id === plId);
  if (!pl || !song) return false;
  if (song.localId) {
    pl.coverId = song.localId;
    pl.img = '';
  } else if (song.img) {
    pl.img = song.img;
    pl.coverId = null;
  } else {
    return false;
  }
  if (pl.customCover) {
    pl.customCover = false;
    const key = CUSTOM_COVER_PREFIX + plId;
    try { await idbDelete(STORE_COVER, key); } catch { /* 忽略 */ }
    if (coverUrlCache.has(key)) { URL.revokeObjectURL(coverUrlCache.get(key)); coverUrlCache.delete(key); }
  }
  saveMeta();
  return true;
}

/** 自定义封面 URL(未设置返回 '') */
export async function getCustomCoverUrl(plId) {
  return getCoverUrl(CUSTOM_COVER_PREFIX + plId);
}

/** 删歌单定义 + GC 孤儿:未被任何剩余歌单引用、且不在 protectedIds 中的歌 → 删 blob/元数据;自定义封面一并删 */
export async function removePlaylist(plId, { protectedIds = [] } = {}) {
  state.playlists = state.playlists.filter((p) => p.id !== plId);
  const key = CUSTOM_COVER_PREFIX + plId;
  try { await idbDelete(STORE_COVER, key); } catch { /* 忽略 */ }
  if (coverUrlCache.has(key)) { URL.revokeObjectURL(coverUrlCache.get(key)); coverUrlCache.delete(key); }
  const referenced = new Set(state.playlists.flatMap((p) => p.songIds));
  const orphanIds = state.songs
    .map((s) => s.localId)
    .filter((id) => !referenced.has(id) && !protectedIds.includes(id));
  saveMeta();
  if (orphanIds.length) await removeSongs(orphanIds);
}

/** 删 blob/封面/元数据/歌单引用 + revoke 缓存 URL */
export async function removeSongs(localIds) {
  for (const id of localIds) {
    try { await idbDelete(STORE_AUDIO, id); } catch { /* 忽略 */ }
    try { await idbDelete(STORE_COVER, id); } catch { /* 忽略 */ }
    if (playUrlCache.has(id)) {
      URL.revokeObjectURL(playUrlCache.get(id));
      playUrlCache.delete(id);
    }
    if (coverUrlCache.has(id)) {
      URL.revokeObjectURL(coverUrlCache.get(id));
      coverUrlCache.delete(id);
    }
  }
  const set = new Set(localIds);
  state.songs = state.songs.filter((s) => !set.has(s.localId));
  dropSongRefs(localIds);
  saveMeta();
}

/** blob 丢失自愈(播放失败时调):只删元数据/引用,不删 IDB */
export async function forgetSong(localId) {
  if (playUrlCache.has(localId)) {
    URL.revokeObjectURL(playUrlCache.get(localId));
    playUrlCache.delete(localId);
  }
  state.songs = state.songs.filter((s) => s.localId !== localId);
  dropSongRefs([localId]);
  saveMeta();
}

// ---------- 测试钩子 ----------
export async function idbCountTotal() {
  return idbCount(STORE_AUDIO);
}

export async function reset() {
  try {
    await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_AUDIO, STORE_COVER], 'readwrite');
      tx.objectStore(STORE_AUDIO).clear();
      tx.objectStore(STORE_COVER).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* IDB 不可用时仅清元数据 */ }
  for (const url of playUrlCache.values()) URL.revokeObjectURL(url);
  for (const url of coverUrlCache.values()) URL.revokeObjectURL(url);
  playUrlCache.clear();
  coverUrlCache.clear();
  state.songs = [];
  state.playlists = [];
  saveMeta();
}

window.__APP_LOCAL = state; // 原地 mutate 稳定引用(fx.js 同模式)
window.__APP_LOCAL_API = {
  importFiles, createPlaylist, removePlaylist, removeSongs,
  getPlayUrl, getCoverUrl, getPlaylistSongs, addSongToPlaylist,
  setCustomCover, setPlaylistCoverFromSong, getCustomCoverUrl,
  idbCount: idbCountTotal, reset,
};
