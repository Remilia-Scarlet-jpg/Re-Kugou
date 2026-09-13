/**
 * 酷狗 API 客户端(app_win.exe,:3000)+ 各数据源字段归一化。
 * 所有函数 async,失败抛错(由调用方转 toast)。
 */
import { CONFIG } from './config.js';

async function getJson(path, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const url = `${CONFIG.API_BASE}${path}${qs.size ? '?' + qs : ''}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 多个来源的作者数组 → "周杰伦、方文山";元素可能是 {author_name|name} 或纯字符串 */
function joinArtists(authors, fallback) {
  const joined = (Array.isArray(authors) ? authors : [])
    .map((a) => (typeof a === 'string' ? a : a?.author_name || a?.name || ''))
    .filter(Boolean)
    .join('、');
  return joined || fallback || '未知歌手';
}

/** 统一歌曲结构:{hash,name,artists,img,duration} */
function normSong(raw) {
  return {
    hash: raw.hash || '',
    name: raw.name || '未知歌曲',
    artists: raw.artists || '未知歌手',
    img: raw.img || '',
    duration: raw.duration,
  };
}

// ---------- 发现 ----------

/** 每日推荐 → Song[](time_length 新版为秒、旧版为毫秒,按量级兼容);
 * credentials 带 cookie:登录用户 userid 生效 → 个性化推荐;未登录 userid=0 → 通用推荐 30 首/天 */
export async function getRecommendSongs() {
  const d = await getJsonCred('/recommend/songs', { timestamp: Date.now() }); // timestamp 破 2 分钟缓存
  const list = d?.data?.song_list || [];
  return list.map((s) =>
    normSong({
      hash: s.hash,
      name: s.songname,
      artists: joinArtists(s.singerinfo, s.author_name),
      img: s.sizable_cover,
      duration: s.time_length
        ? s.time_length >= 1000
          ? Math.round(s.time_length / 1000)
          : s.time_length
        : undefined,
    })
  );
}

/** 榜单列表 → [{rankid,rankname,img}] */
export async function getRankLists() {
  const d = await getJson('/rank/list');
  return (d?.data?.info || []).map((r) => ({
    rankid: r.rankid,
    rankname: r.rankname || '未知榜单',
    img: r.banner_9 || r.img || r.custom_logo || '',
  }));
}

/** 榜单歌曲 → Song[]
 * lite 形状:audio_info 为对象(hash_128/hash)、时长在 deprecated.duration(毫秒);
 * 标准版 audio_info 为 hash 字符串,同样兼容 */
export async function getRankSongs(rankid, bannerImg = '') {
  const d = await getJson('/rank/audio', { rankid });
  const list = d?.data?.songlist || [];
  return list.map((s) => {
    const ai = s.audio_info;
    const hash =
      typeof ai === 'string'
        ? ai
        : ai?.hash_128 || ai?.hash || s.deprecated?.hash || s.trans_param?.ogg_128_hash || '';
    const ms = s.timelength || s.deprecated?.duration || (typeof ai === 'object' ? ai?.duration_128 : undefined);
    const hash320 = typeof ai === 'object' ? ai?.hash_320 || s.trans_param?.ogg_320_hash || '' : s.trans_param?.ogg_320_hash || '';
    return normSong({
      hash,
      hash320,
      name: s.songname,
      artists: joinArtists(s.authors, s.author_name),
      img: bannerImg,
      duration: ms ? Math.round(ms / 1000) : undefined,
    });
  });
}

// ---------- 专辑 ----------

/** 专辑搜索 → [{albumid,albumname,singer,img,intro}] */
export async function searchAlbums(keywords) {
  const d = await getJson('/search', { keywords, type: 'album', pagesize: 24 });
  return (d?.data?.lists || []).map((a) => ({
    albumid: a.albumid,
    albumname: a.albumname || '未知专辑',
    singer: a.singer || a.author_name || '未知歌手',
    img: a.img || '',
    intro: a.intro || '',
  }));
}

/** 专辑歌曲 → Song[](album_info 新版为字符串 URL、旧版为 {cover} 对象,兼容) */
export async function getAlbumSongs(albumid) {
  const d = await getJson('/album/songs', { id: albumid });
  return (d?.data?.songs || []).map((s) =>
    normSong({
      hash: s.audio_info?.hash,
      hash320: s.audio_info?.hash_320 || s.trans_param?.ogg_320_hash || '',
      name: s.base?.audio_name,
      artists: joinArtists(s.authors, s.base?.author_name),
      img: typeof s.album_info === 'string' ? s.album_info : s.album_info?.cover || '',
      duration: s.audio_info?.duration ? Math.round(s.audio_info.duration / 1000) : undefined,
    })
  );
}

// ---------- 歌曲 ----------

/**
 * 歌曲搜索 → Song[]。
 * lite 模式 type=song 走 /v3 通道报 152(Parameter Error,实测);type=lyric(词曲检索)
 * 反而返回完整可播放歌曲元数据:FileHash(128k)/320Hash/trans_param.ogg_320_hash/
 * TimeLength(秒)/Image({size} 占位,由 fixImgUrl 替换)/SingerName。
 */
export async function searchSongs(keywords) {
  const d = await getJson('/search', { keywords, type: 'lyric', pagesize: 24 });
  return (d?.data?.lists || []).map((p) =>
    normSong({
      hash: p.FileHash || p.SQHash || '',
      hash320: p['320Hash'] || p.trans_param?.ogg_320_hash || '',
      name: p.SongName || '未知歌曲',
      artists: p.SingerName || '未知歌手',
      img: p.Image || '',
      duration: p.TimeLength || undefined,
    })
  );
}

// ---------- 歌单 ----------

/** 歌单搜索 → [{specialid,specialname,nickname,img,playCount}] */
export async function searchPlaylists(keywords) {
  const d = await getJson('/search', { keywords, type: 'special', pagesize: 24 });
  return (d?.data?.lists || []).map((p) => ({
    specialid: p.specialid,
    specialname: p.specialname || '未知歌单',
    nickname: p.nickname || '',
    img: p.img || '',
    playCount: p.total_play_count || p.play_count || '',
    // 收藏他人歌单需要原始歌单三要素(缺一上游会拒),列表页不一定都带,故各自兜底空串
    gid: p.global_collection_id || p.gid || '',
    userid: p.userid || p.create_userid || p.list_create_userid || '',
  }));
}

// ---------- 我的酷狗(账号信息 / 听歌排行 / 收藏歌单) ----------

/** 账号信息(/user/detail → v3/get_my_info):nickname、userid、vip 相关字段 */
export async function getUserDetail() {
  const d = await getJsonCred('/user/detail', { timestamp: Date.now() });
  return d?.data || null;
}

/** 听歌历史排行(/user/listen → v2/get_list):data.info 为按播放次数排序的曲目
 *  type = list_type:0 本周 / 1 全部(上游两套榜单,0 为空时前端会再试 1) */
export async function getListenRank(type = 0) {
  const d = await getJsonCred('/user/listen', { type, timestamp: Date.now() });
  return d?.data || null;
}

/**
 * 收藏他人歌单到自己的酷狗账号(/playlist/add → cloudlist v5/add_list):
 * type=1 表示收藏既有歌单,需带原始歌单的 listid/gid/创建者 userid;
 * token/userid 由服务端从 HttpOnly cookie 读取(前端不接触凭据)。
 */
export async function collectPlaylist({ name, listid, gid = '', createUserid = '' }) {
  const d = await getJsonCred('/playlist/add', {
    name: String(name || ''),
    type: 1,
    source: 1,
    list_create_listid: String(listid || ''),
    list_create_gid: String(gid || ''),
    list_create_userid: String(createUserid || ''),
    timestamp: Date.now(),
  });
  return d;
}

/**
 * 歌单曲目(经本地服务代理)。
 * - 数字歌单号 → m.kugou 老接口:仅前 10 首;私有歌单返回 error
 * - 链接/短链(含 t1.kugou.com App 分享)→ 服务端解析:
 *   分享页(wwwapi /share/)内嵌完整曲目列表(可达 100 首),无歌单名(name 为空)
 * specialid 为 http 链接时自动按 url= 发送。
 * → {id, name, songs:[Song], error:''}
 */
export async function getPlaylistSongs(specialid, url = '') {
  const link = /^https?:/i.test(String(specialid || '')) ? specialid : url;
  const q = link ? `url=${encodeURIComponent(link)}` : `id=${encodeURIComponent(specialid)}`;
  const res = await fetch(`${CONFIG.PLAYLIST_API}?${q}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();
  if (!d.ok) return { id: '', name: '', songs: [], error: d.error || '歌单不可用' };
  return { id: String(d.id || specialid || ''), name: d.name || '', songs: d.songs || [], error: '' };
}

/**
 * 从用户粘贴的文本解析歌单:
 * 带歌单号的酷狗链接(plist/list/ID 或 yy/special/single/ID)→ {id};
 * 其他酷狗链接(如 t1.kugou.com 短链)→ {url}(交给服务端解析);
 * 纯数字(≥6 位,视为歌单号)→ {id};识别不了 → null。
 */
export function parsePlaylistInput(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const link = t.match(/https?:\/\/[^\s"'<>]*kugou\.com[^\s"'<>]*/i);
  if (link) {
    // 微信/聊天软件复制常带尾部中文标点,剥离后再拼 URL(否则服务端跳转失败)
    const clean = link[0].replace(/[。!?;:,、]+$/g, '');
    const idm = clean.match(/(?:plist\/list|special\/single)\/(\d+)/i);
    if (idm) return { id: idm[1] };
    return { url: clean };
  }
  const idm = t.match(/\d{6,}/);
  if (idm) return { id: idm[0] };
  return null;
}

// ---------- 封面 ----------

/**
 * 歌曲封面补全(hash + album_id → /images,android 签名接口,实测 lite 可用)。
 * 分享歌单解析出的歌只有 hash + album_id 而无封面,由它补全;
 * 响应封面在 data[0].album[0].sizable_cover({size} 占位,由 fixImgUrl 替换)。
 * 失败返回 ''(调用方回退词曲检索/占位图)。
 */
export async function getSongCover(hash, albumId) {
  try {
    const d = await getJson('/images', { hash, album_id: albumId, count: 1 });
    return d?.data?.[0]?.album?.[0]?.sizable_cover || '';
  } catch {
    return '';
  }
}

// ---------- 歌词 ----------

/** 歌词检索 → {id,accesskey} 或 null */
export async function searchLyric(song) {
  try {
    const d = await getJson('/search/lyric', {
      hash: song.hash,
      keyword: song.name,
      duration: song.duration ? song.duration * 1000 : undefined,
    });
    const c = d?.candidates?.[0];
    if (!c?.id || !c?.accesskey) return null;
    return { id: c.id, accesskey: c.accesskey };
  } catch {
    return null;
  }
}

/** 歌词内容 → 解码后的 LRC 文本;失败返回 null */
export async function getLyric(id, accesskey) {
  const d = await getJson('/lyric', { id, accesskey, decode: 1, fmt: 'lrc' });
  return d?.decodeContent || d?.content || null;
}

// ---------- 播放地址 ----------

/**
 * 解析播放地址(经本地服务代理 trackercdn)。
 * → {urls:[...]} 或 {error:'...'};网络异常抛错。
 */
export async function resolvePlayUrl(hash) {
  const res = await fetch(`${CONFIG.URL_API}?hash=${encodeURIComponent(hash)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();
  if (!d.ok) return { urls: [], error: d.error };
  return { urls: d.urls || [] };
}

/**
 * 登录态优先音源:/song/url(trackercdn v5)返回可直播的 mp3 地址数组。
 * 实测:/song/url/new(v6)虽返回 320k 地址,但文件是 .mgg 加密格式,浏览器 <audio> 无法解码;
 * v5 带登录 cookie 返回明文 .mp3(含 VIP 锁定曲),未登录则被风控(20028)。
 * 返回空数组 = 失败/未授权,调用方回退公开音源链。
 */
export async function getSongUrlVip(hash, quality = '320') {
  try {
    // 带 timestamp 绕开 API 2 分钟缓存,保证每次拿到新地址
    const d = await getJsonCred('/song/url', { hash, quality, timestamp: Date.now() });
    if (d?.status !== 1) return [];
    const urls = [...(d.url || []), ...(d.backupUrl || [])];
    // 只收明文 mp3 直链(防 .mgg 加密格式)
    return urls.filter((u) => typeof u === 'string' && /\.mp3($|\?)/i.test(u));
  } catch {
    return [];
  }
}

// ---------- 登录 / VIP ----------

/**
 * 带凭证的请求(credentials:'include'):
 * 跨端口同 host,酷狗 API 的 Set-Cookie(token/userid)才能被浏览器保存并回传。
 */
async function getJsonCred(path, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const url = `${CONFIG.API_BASE}${path}${qs.size ? '?' + qs : ''}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 二维码登录:取 key 与二维码 PNG(data URL,由 API 直接返回,无需本地生成) */
export async function getQrKey() {
  // API 有 2 分钟响应缓存,相同 URL 返回缓存;加 timestamp 保证每次拿到新二维码
  const d = await getJsonCred('/login/qr/key', { timestamp: Date.now() });
  const q = d?.data || {};
  return { key: q.qrcode || '', img: q.qrcode_img || '' };
}

/** 扫码状态:0 过期 / 1 等待扫码 / 2 已扫码待确认 / 4 成功(此时 token cookie 已写入) */
export async function checkQrLogin(key) {
  // 关键:不带 timestamp 时相同 URL 会被 API 缓存 2 分钟,扫码后的状态永远拿不到
  const d = await getJsonCred('/login/qr/check', { key, timestamp: Date.now() });
  const status = Number(d?.data?.status ?? 0);
  if (status === 4) persistLoginCookies(d?.data);
  return status;
}

/**
 * 登录态持久化:SECURITY_RULES 规则6——token 不再由前端写 document.cookie
 * (服务端 Set-Cookie 已带 HttpOnly + Max-Age=31536000,浏览器/安装版重启不丢);
 * 前端仅把 token/userid 存 localStorage(vmp.login.v1)供 UI 判定登录态。
 */
export function persistLoginCookies(data) {
  if (!data || typeof document === 'undefined') return;
  const login = { token: data.token || '', userid: data.userid || '', ts: Date.now() };
  localStorage.setItem('vmp.login.v1', JSON.stringify(login));
}

/** 登录态判定:读 localStorage(vmp.login.v1);HttpOnly token cookie 前端读不到 */
export function hasLogin() {
  try {
    const s = JSON.parse(localStorage.getItem('vmp.login.v1') || 'null');
    return !!(s && s.token);
  } catch {
    return false;
  }
}

/**
 * 旧数据迁移(2026-08 安全改造):老版本把 token 写进了非 HttpOnly cookie;
 * 首次启动读到旧 token= cookie 时迁入 localStorage,并请求服务端 /auth/logout
 * 幂等清除旧 cookie(响应到达前 UI 仍能按 localStorage 判定登录态)。
 */
export function migrateLegacyLogin() {
  if (typeof document === 'undefined' || hasLogin()) return;
  const mt = document.cookie.match(/(?:^|;\s*)token=([^;]+)/);
  if (!mt || !mt[1]) return;
  const mu = document.cookie.match(/(?:^|;\s*)userid=([^;]+)/);
  persistLoginCookies({ token: mt[1], userid: mu ? mu[1] : '' });
  fetch(`${CONFIG.API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' }).catch(() => {});
}

/** 用户 VIP 信息 → 原始 data;未登录/失败返回 null */
export async function getUserVip() {
  try {
    // timestamp:防同 URL 缓存(服务端也已排除 /user 路径缓存,双保险)
    const d = await getJsonCred('/user/vip/detail', { timestamp: Date.now() });
    const data = d?.data;
    if (!data || data.errmsg) return null;
    return data;
  } catch {
    return null;
  }
}

/** 退出登录:服务端 /auth/logout 清 9 键 cookie(HttpOnly 前端删不掉),本地清 localStorage;失败也清本地 */
export async function logoutKugou() {
  try {
    await fetch(`${CONFIG.API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' });
  } catch {}
  localStorage.removeItem('vmp.login.v1');
}
