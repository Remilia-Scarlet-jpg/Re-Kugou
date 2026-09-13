/**
 * UI 层:视图渲染(推荐/榜单/专辑/歌单)+ 播放条 + 歌词抽屉 + toast。
 * 全部中文文案集中在本文件。
 */
import * as api from './api.js';
import { player } from './player.js';
import { LyricsView } from './lyrics.js';
import * as localMusic from './local-music.js';
import { fixImgUrl, formatTime, escapeHtml, PLACEHOLDER_IMG } from './utils.js';

const $ = (id) => document.getElementById(id);

/** 队列曲目唯一键:在线歌 hash / 本地歌 localId(本地歌 hash 恒空串,selector 不能落空) */
const songKey = (s) => s?.hash || s?.localId || '';

const el = {
  main: $('main'),
  searchInput: $('search-input'),
  searchBtn: $('search-btn'),
  npCover: $('np-cover'),
  npName: $('np-name'),
  npArtist: $('np-artist'),
  npWrap: $('np-cover-wrap'),
  btnPlay: $('btn-play'),
  btnPrev: $('btn-prev'),
  btnNext: $('btn-next'),
  btnMode: $('btn-mode'),
  seek: $('seek'),
  timeCur: $('time-cur'),
  timeDur: $('time-dur'),
  volume: $('volume'),
  volumeNum: $('volume-num'),
  btnMute: $('btn-mute'),
  lyricToggle: $('lyric-toggle'),
  lyricDrawer: $('lyric-drawer'),
  lyricTitle: $('lyric-title'),
  lyricCover: $('lyric-cover'),
  lyricBody: $('lyric-body'),
  lyricClose: $('lyric-close'),
  toasts: $('toasts'),
  loginModal: $('login-modal'),
  loginClose: $('login-close'),
  qrImg: $('qr-img'),
  qrStatus: $('qr-status'),
  rightDrawer: $('right-drawer'),
  drawerTab: $('drawer-tab'),
  drawerClose: $('drawer-close'),
  floatLogo: $('float-logo'),
  drawerUser: $('drawer-user'),
  drawerUserTitle: $('drawer-user-title'),
  drawerUserSub: $('drawer-user-sub'),
  browsePane: $('browse-pane'),
  queuePane: $('queue-pane'),
  queueView: $('queue-view'),
  visualPane: $('visual-pane'),
};

let currentView = 'recommend';
let searchType = 'album';
let pendingSearch = ''; // 当前搜索结果对应的关键词
let activeTab = 'browse'; // 抽屉当前标签页
const cache = {}; // 简单内存缓存,避免重复请求

export const lyricsView = new LyricsView({
  title: el.lyricTitle,
  body: el.lyricBody,
  onSeek: (sec) => player.seek(sec),
  toast,
});

// ---------- Toast ----------
export function toast(msg, warn = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (warn ? ' warn' : '');
  t.textContent = msg;
  el.toasts.appendChild(t);
  setTimeout(() => t.remove(), 2600);
  // 最多保留 3 条,防止堆叠过高
  while (el.toasts.children.length > 3) el.toasts.firstChild.remove();
}

// ---------- 通用片段 ----------
// CSP(script-src 'self')下禁用内联 onerror 属性,封面失败回退改插入后绑定事件
const coverImg = (url, size, cls = 'card-cover') =>
  `<img class="${cls}" src="${escapeHtml(fixImgUrl(url, size) || PLACEHOLDER_IMG)}" loading="lazy">`;

/** 容器内全部封面图绑定失败回退(once,占位图本身不会失败,防循环) */
function bindCoverFallback(container) {
  if (!container) return;
  container.querySelectorAll('img').forEach((img) => {
    img.addEventListener('error', () => {
      if (img.src !== PLACEHOLDER_IMG) img.src = PLACEHOLDER_IMG;
    }, { once: true });
  });
}

const loadingBox = () => '<div class="state-box"><div class="spinner"></div>加载中…</div>';
const emptyBox = (msg) => `<div class="state-box">${escapeHtml(msg)}</div>`;

/** 歌曲行(榜单/专辑共用);eq 由 markPlayingRows 动态插入 */
function songRow(song, i) {
  return `
    <div class="song-row" data-hash="${escapeHtml(song.hash || song.localId || '')}">
      <div class="idx">${i + 1}</div>
      ${coverImg(song.img, 240, 'row-cover')}
      <div class="row-meta">
        <div class="row-name">${escapeHtml(song.name)}</div>
        <div class="row-artist">${escapeHtml(song.artists)}</div>
      </div>
      <div class="row-dur">${song.duration != null ? formatTime(song.duration) : '--:--'}</div>
      <button class="row-play" title="播放">▶</button>
      <button class="row-add" title="加入本地歌单">＋</button>
    </div>`;
}

/** 绑定一组歌曲行的点击:整行 = 播放队列中该曲;右侧按钮同理;＋ = 加入本地歌单 */
function bindSongRows(container, songs) {
  container.querySelectorAll('.song-row').forEach((row) => {
    const i = [...row.parentElement.children].indexOf(row);
    row.addEventListener('click', () => player.setQueue(songs, i));
    row.querySelector('.row-play').addEventListener('click', (e) => {
      e.stopPropagation();
      player.setQueue(songs, i);
    });
    row.querySelector('.row-add').addEventListener('click', (e) => {
      e.stopPropagation();
      showAddToPlaylistUI(songs[i]);
    });
  });
}

// ---------- 加入本地歌单(推荐/搜索/榜单/歌单的在线歌均可收入)+ 歌单封面选择 ----------
/** 通用玻璃弹层:返回 { ov, menu, close };点击遮罩关闭 */
function overlayOpen(html) {
  const ov = document.createElement('div');
  ov.className = 'vmp-overlay';
  const menu = document.createElement('div');
  menu.className = 'vmp-menu';
  menu.innerHTML = html;
  ov.appendChild(menu);
  const close = () => ov.remove();
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  document.body.appendChild(ov);
  return { ov, menu, close };
}

/** 把一首歌(本地/在线)加入本地歌单:弹层选歌单或新建 */
function showAddToPlaylistUI(song) {
  if (!song || (!song.hash && !song.localId)) return;
  const lists = localMusic.getPlaylists();
  const rows = lists.length
    ? lists.map((pl) => {
        const count = (pl.songIds?.length || 0) + (pl.onlineSongs?.length || 0);
        return `<button class="vmp-item" data-id="${escapeHtml(pl.id)}"><span class="vmp-item-name">${escapeHtml(pl.name)}</span><span class="vmp-item-sub">${count} 首</span></button>`;
      }).join('')
    : '<div class="vmp-empty">还没有本地歌单</div>';
  const { menu, close } = overlayOpen(
    `<div class="vmp-head">添加到本地歌单<span class="vmp-head-sub">${escapeHtml(song.name)}</span></div>
     <div class="vmp-list">${rows}</div>
     <div class="vmp-actions"><button class="vmp-btn" data-act="new">＋ 新建歌单</button><button class="vmp-btn" data-act="cancel">取消</button></div>`
  );
  menu.querySelectorAll('.vmp-item').forEach((b) => {
    b.addEventListener('click', () => {
      const name = b.querySelector('.vmp-item-name').textContent;
      if (localMusic.addSongToPlaylist(b.dataset.id, song)) {
        syncLocalPlaylistCounts();
        toast(`已加入「${name}」`);
      } else {
        toast('加入失败,请重试', true);
      }
      close();
    });
  });
  menu.querySelector('[data-act=cancel]').addEventListener('click', close);
  menu.querySelector('[data-act=new]').addEventListener('click', () => {
    menu.innerHTML =
      `<div class="vmp-head">新建本地歌单</div>
       <div class="vmp-list"><input id="vmp-new-name" class="vmp-input" type="text" placeholder="歌单名称" value="${escapeHtml(song.name)}"></div>
       <div class="vmp-actions"><button class="vmp-btn" data-act="ok">创建并加入</button><button class="vmp-btn" data-act="cancel">取消</button></div>`;
    menu.querySelector('[data-act=cancel]').addEventListener('click', close);
    menu.querySelector('[data-act=ok]').addEventListener('click', async () => {
      const name = menu.querySelector('#vmp-new-name').value.trim() || song.name || '我的歌单';
      const pl = await localMusic.createPlaylist(name, [], []);
      if (localMusic.addSongToPlaylist(pl.id, song)) {
        insertMyPlaylist({ specialid: 'local:' + pl.id, specialname: name, img: '', count: 1, local: true });
        toast(`已创建「${name}」并加入`);
      }
      close();
    });
  });
}

/** 图片 → 480×480 居中正方形 WebP(歌单自定义封面,控体积) */
function makeSquareCover(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      URL.revokeObjectURL(url);
      const S = 480;
      const cv = document.createElement('canvas');
      cv.width = cv.height = S;
      const ctx = cv.getContext('2d');
      const side = Math.min(im.width, im.height);
      ctx.drawImage(im, (im.width - side) / 2, (im.height - side) / 2, side, side, 0, 0, S, S);
      cv.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob fail'))), 'image/webp', 0.85);
    };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
    im.src = url;
  });
}

/** 歌单封面选择:歌单内歌曲封面缩略图 / 本机图片上传(压缩 480 WebP 存 IDB) */
async function showCoverPicker(pl) {
  const songs = localMusic.getPlaylistSongs(pl);
  const items = [];
  for (const s of songs) {
    let src = '';
    if (s.localId) {
      src = await localMusic.getCoverUrl(s.localId).catch(() => '');
    } else {
      src = fixImgUrl(s.img, 240);
    }
    if (src) items.push({ src, song: s });
  }
  const grid = items.length
    ? `<div class="plc-grid">${items.map((it, i) => `<button class="plc-item" data-i="${i}"><img src="${escapeHtml(it.src)}" alt=""></button>`).join('')}</div>`
    : '<div class="vmp-empty">歌单内暂无带封面的歌</div>';
  const { menu, close } = overlayOpen(
    `<div class="vmp-head">选择歌单封面</div>${grid}
     <div class="vmp-actions"><button class="vmp-btn" data-act="upload">📁 从本机选图片</button><button class="vmp-btn" data-act="cancel">取消</button></div>`
  );
  menu.querySelectorAll('.plc-item').forEach((b) => {
    b.addEventListener('click', async () => {
      await localMusic.setPlaylistCoverFromSong(pl.id, items[Number(b.dataset.i)].song);
      toast('封面已更新');
      close();
      renderMyPlaylists();
    });
  });
  menu.querySelector('[data-act=cancel]').addEventListener('click', close);
  menu.querySelector('[data-act=upload]').addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      inp.value = '';
      if (!f) return;
      try {
        await localMusic.setCustomCover(pl.id, await makeSquareCover(f));
        toast('封面已更新');
        close();
        renderMyPlaylists();
      } catch { toast('图片处理失败,请重试', true); }
    };
    inp.click();
  });
}

/** 标记当前播放行:加 .playing + 序号处插入均衡条 */
export function markPlayingRows(hash) {  document.querySelectorAll('.song-row.playing').forEach((r) => {
    if (r.dataset.hash !== hash) {
      r.classList.remove('playing');
      r.querySelector('.idx .eq')?.remove();
      r.querySelector('.idx').textContent = r.dataset.origIdx ?? '';
    }
  });
  if (!hash) return;
  document.querySelectorAll(`.song-row[data-hash="${hash}"]`).forEach((r) => {
    r.classList.add('playing');
    const idx = r.querySelector('.idx');
    if (!idx.querySelector('.eq')) {
      idx.dataset.origIdx = idx.textContent;
      idx.innerHTML = '<span class="eq"><span></span><span></span><span></span></span>';
    }
  });
}

/** 本地歌封面:从 IDB 现取 objectURL 到渲染副本(原始队列对象不动,避免 blob URL 被持久化) */
const resolveLocalImgs = (songs) => Promise.all(songs.map(async (s) =>
  (s?.local && s.cover) ? { ...s, img: await localMusic.getCoverUrl(s.localId).catch(() => '') } : s));

// ---------- 右侧抽屉与队列 ----------
function openDrawer() {
  el.rightDrawer.classList.add('open');
}
function closeDrawer() {
  el.rightDrawer.classList.remove('open');
}
function toggleDrawer() {
  el.rightDrawer.classList.toggle('open');
}

/** 抽屉标签页切换:浏览 / 队列 / 视觉 */
function switchTab(tab) {
  if (tab !== 'browse' && tab !== 'queue' && tab !== 'visual') return;
  activeTab = tab;
  document.querySelectorAll('.drawer-tab-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  el.browsePane.hidden = tab !== 'browse';
  el.queuePane.hidden = tab !== 'queue';
  el.visualPane.hidden = tab !== 'visual';
  if (tab === 'queue') renderQueue();
}

/** 渲染播放队列:当前曲高亮(复用 markPlayingRows),点击任意行切歌 */
async function renderQueue() {
  const q = player.getQueue();
  const cur = player.getCurrent();
  if (!q.length) {
    el.queueView.innerHTML = emptyBox('队列为空 · 去浏览页挑几首歌吧');
    return;
  }
  const display = await resolveLocalImgs(q); // 仅渲染用副本,不污染队列持久化数据
  el.queueView.innerHTML =
    `<div class="view-title">🗂 播放队列<span class="sub">共 ${q.length} 首 · 点击切换</span></div>` +
    `<div class="song-list">${display.map((s, i) => songRow(s, i)).join('')}</div>`;
  bindCoverFallback(el.queueView);
  el.queueView.querySelectorAll('.song-row').forEach((row, i) => {
    row.addEventListener('click', () => player.playAt(i));
    row.querySelector('.row-play').addEventListener('click', (e) => {
      e.stopPropagation();
      player.playAt(i);
    });
    row.querySelector('.row-add').addEventListener('click', (e) => {
      e.stopPropagation();
      showAddToPlaylistUI(q[i]);
    });
  });
  if (cur) markPlayingRows(songKey(cur));
}

// ---------- 视图路由 ----------
function showView(name, param) {
  currentView = name;
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === name);
  });
  switch (name) {
    case 'recommend': return renderRecommend();
    case 'rank': return renderRankList();
    case 'song': return renderSongSearch(param ?? pendingSearch);
    case 'album': return renderAlbumSearch(param ?? pendingSearch);
    case 'playlist': return renderPlaylistSearch(param ?? pendingSearch);
    case 'my': return renderMyPlaylists();
    case 'user': return renderUserPage();
    default: console.warn('未知视图:', name);
  }
}

// ---------- 推荐 ----------
async function renderRecommend() {
  el.main.innerHTML = '<div class="view-title">✨ 每日推荐<span class="sub">猜你喜欢 · 点卡片即播</span></div>' + loadingBox();
  try {
    const songs = cache.recommend || (cache.recommend = await api.getRecommendSongs());
    if (!songs.length) return (el.main.innerHTML = emptyBox('推荐列表暂时为空'));
    const cards = songs.map(
      (s, i) => `
      <div class="card" data-i="${i}" data-hash="${escapeHtml(s.hash)}">
        <div class="card-play-hint">${coverImg(s.img, 480)}<button class="play-badge">▶</button><button class="card-add" title="加入本地歌单">＋</button></div>
        <div class="card-name">${escapeHtml(s.name)}</div>
        <div class="card-sub">${escapeHtml(s.artists)}</div>
      </div>`
    );
    el.main.innerHTML = '<div class="view-title">✨ 每日推荐<span class="sub">猜你喜欢 · 点卡片即播</span></div>' +
      `<div class="card-grid">${cards.join('')}</div>`;
    bindCoverFallback(el.main);
    el.main.querySelectorAll('.card').forEach((c) => {
      c.addEventListener('click', () => player.setQueue(songs, Number(c.dataset.i)));
      c.querySelector('.card-add').addEventListener('click', (e) => {
        e.stopPropagation();
        showAddToPlaylistUI(songs[Number(c.dataset.i)]);
      });
    });
  } catch {
    el.main.innerHTML = emptyBox('加载失败');
    toast('无法连接音乐服务,请稍后重试', true);
  }
}

// ---------- 榜单 ----------
async function renderRankList() {
  el.main.innerHTML = '<div class="view-title">🏆 排行榜<span class="sub">官方榜单 · 点开即听</span></div>' + loadingBox();
  try {
    const ranks = cache.ranks || (cache.ranks = await api.getRankLists());
    if (!ranks.length) return (el.main.innerHTML = emptyBox('榜单暂时为空'));
    const cards = ranks.map(
      (r, i) => `
      <div class="card" data-i="${i}">
        <div class="card-play-hint">${coverImg(r.img, 480)}<button class="play-badge">▶</button></div>
        <div class="card-name">${escapeHtml(r.rankname)}</div>
        <div class="card-sub">点击查看榜单歌曲</div>
      </div>`
    );
    el.main.innerHTML = '<div class="view-title">🏆 排行榜<span class="sub">官方榜单 · 点开即听</span></div>' +
      `<div class="card-grid">${cards.join('')}</div>`;
    bindCoverFallback(el.main);
    el.main.querySelectorAll('.card').forEach((c) => {
      c.addEventListener('click', () => renderRankSongs(ranks[Number(c.dataset.i)]));
    });
  } catch {
    el.main.innerHTML = emptyBox('加载失败');
    toast('无法连接音乐服务,请稍后重试', true);
  }
}

async function renderRankSongs(rank) {
  el.main.innerHTML =
    `<div class="view-title"><button class="back-btn">‹ 返回榜单</button> ${escapeHtml(rank.rankname)}</div>` + loadingBox();
  el.main.querySelector('.back-btn').addEventListener('click', () => renderRankList());
  try {
    const songs = await api.getRankSongs(rank.rankid, rank.img);
    if (!songs.length) return (el.main.innerHTML = `<div class="view-title"><button class="back-btn">‹ 返回榜单</button> ${escapeHtml(rank.rankname)}</div>` + emptyBox('该榜单暂时没有歌曲'));
    renderSongListView(songs, rank.rankname, rank.img);
  } catch {
    el.main.innerHTML = `<div class="view-title"><button class="back-btn">‹ 返回榜单</button> ${escapeHtml(rank.rankname)}</div>` + emptyBox('加载失败');
    toast('无法连接音乐服务,请稍后重试', true);
  }
}

async function renderSongListView(songs, title, opts = {}) {
  const { coverUrl = '', sub = `共 ${songs.length} 首`, backLabel = '‹ 返回榜单', onBack = renderRankList } = opts;
  const display = await resolveLocalImgs(songs); // 仅渲染用副本,绑定仍用原始 songs
  const rows = display.map((s, i) => {
    const song = coverUrl && !s.img ? { ...s, img: coverUrl } : s;
    return songRow(song, i);
  });
  el.main.innerHTML =
    `<div class="view-title"><button class="back-btn">${escapeHtml(backLabel)}</button> ${escapeHtml(title)}<span class="sub">${escapeHtml(sub)}</span></div>
     <div class="song-list">${rows.join('')}</div>`;
  bindCoverFallback(el.main);
  el.main.querySelector('.back-btn').addEventListener('click', onBack);
  bindSongRows(el.main.querySelector('.song-list'), songs);
  const cur = player.getCurrent();
  if (cur) markPlayingRows(songKey(cur));
}

// ---------- 歌曲 ----------
async function renderSongSearch(keyword) {
  pendingSearch = keyword || '';
  const title = keyword
    ? `🎵 搜索歌曲<span class="sub">「${escapeHtml(keyword)}」的结果</span>`
    : '🎵 歌曲<span class="sub">搜索歌名或歌手,例如:晴天 周杰伦</span>';
  if (!keyword) {
    el.main.innerHTML = `<div class="view-title">${title}</div>` + emptyBox('在顶部搜索框输入歌名或歌手开始探索');
    return;
  }
  el.main.innerHTML = `<div class="view-title">${title}</div>` + loadingBox();
  try {
    const songs = await api.searchSongs(keyword);
    if (!songs.length) {
      el.main.innerHTML = `<div class="view-title">${title}</div>` + emptyBox('未找到相关歌曲,换个关键词试试');
      return;
    }
    const cards = songs.map(
      (s, i) => `
      <div class="card" data-i="${i}" data-hash="${escapeHtml(s.hash)}">
        <div class="card-play-hint">${coverImg(s.img, 480)}<button class="play-badge">▶</button><button class="card-add" title="加入本地歌单">＋</button></div>
        <div class="card-name">${escapeHtml(s.name)}</div>
        <div class="card-sub">${escapeHtml(s.artists)}${s.duration != null ? ' · ' + formatTime(s.duration) : ''}</div>
      </div>`
    );
    el.main.innerHTML = `<div class="view-title">${title}</div><div class="card-grid">${cards.join('')}</div>`;
    bindCoverFallback(el.main);
    el.main.querySelectorAll('.card').forEach((c) => {
      c.addEventListener('click', () => player.setQueue(songs, Number(c.dataset.i)));
      c.querySelector('.card-add').addEventListener('click', (e) => {
        e.stopPropagation();
        showAddToPlaylistUI(songs[Number(c.dataset.i)]);
      });
    });
  } catch {
    el.main.innerHTML = `<div class="view-title">${title}</div>` + emptyBox('加载失败');
    toast('无法连接音乐服务,请稍后重试', true);
  }
}

// ---------- 专辑 ----------
async function renderAlbumSearch(keyword) {
  pendingSearch = keyword || '';
  const title = keyword
    ? `💿 搜索专辑<span class="sub">「${escapeHtml(keyword)}」的结果</span>`
    : '💿 专辑<span class="sub">搜索歌手或专辑名,例如:周杰伦</span>';
  if (!keyword) {
    el.main.innerHTML = `<div class="view-title">${title}</div>` + emptyBox('在顶部搜索框输入关键词开始探索');
    return;
  }
  el.main.innerHTML = `<div class="view-title">${title}</div>` + loadingBox();
  try {
    const albums = await api.searchAlbums(keyword);
    if (!albums.length) {
      el.main.innerHTML = `<div class="view-title">${title}</div>` + emptyBox('未找到相关专辑,换个关键词试试');
      return;
    }
    const cards = albums.map(
      (a, i) => `
      <div class="card" data-i="${i}">
        <div class="card-play-hint">${coverImg(a.img, 480)}<button class="play-badge">▶</button></div>
        <div class="card-name">${escapeHtml(a.albumname)}</div>
        <div class="card-sub">${escapeHtml(a.singer)}</div>
      </div>`
    );
    el.main.innerHTML = `<div class="view-title">${title}</div><div class="card-grid">${cards.join('')}</div>`;
    bindCoverFallback(el.main);
    el.main.querySelectorAll('.card').forEach((c) => {
      c.addEventListener('click', () => renderAlbumSongs(albums[Number(c.dataset.i)]));
    });
  } catch {
    el.main.innerHTML = `<div class="view-title">${title}</div>` + emptyBox('加载失败');
    toast('无法连接音乐服务,请稍后重试', true);
  }
}

async function renderAlbumSongs(album) {
  el.main.innerHTML =
    `<div class="view-title"><button class="back-btn">‹ 返回专辑搜索</button> ${escapeHtml(album.albumname)}<span class="sub">${escapeHtml(album.singer)}</span></div>` + loadingBox();
  el.main.querySelector('.back-btn').addEventListener('click', () => renderAlbumSearch(pendingSearch));
  try {
    const songs = await api.getAlbumSongs(album.albumid);
    if (!songs.length) return (el.main.innerHTML = `<div class="view-title"><button class="back-btn">‹ 返回专辑搜索</button> ${escapeHtml(album.albumname)}</div>` + emptyBox('该专辑暂时没有歌曲'));
    const rows = songs.map((s, i) => {
      const song = album.img && !s.img ? { ...s, img: album.img } : s;
      return songRow(song, i);
    });
    el.main.innerHTML =
      `<div class="view-title"><button class="back-btn">‹ 返回专辑搜索</button> ${escapeHtml(album.albumname)}<span class="sub">${escapeHtml(album.singer)} · 共 ${songs.length} 首</span></div>
       <div class="song-list">${rows.join('')}</div>`;
    el.main.querySelector('.back-btn').addEventListener('click', () => renderAlbumSearch(pendingSearch));
    bindSongRows(el.main.querySelector('.song-list'), songs);
    const cur = player.getCurrent();
    if (cur) markPlayingRows(cur.hash);
  } catch {
    el.main.innerHTML = `<div class="view-title"><button class="back-btn">‹ 返回专辑搜索</button> ${escapeHtml(album.albumname)}</div>` + emptyBox('加载失败');
    toast('无法连接音乐服务,请稍后重试', true);
  }
}

// ---------- 歌单 ----------
async function renderPlaylistSearch(keyword) {
  pendingSearch = keyword || '';
  const title = keyword
    ? `🎶 搜索歌单<span class="sub">「${escapeHtml(keyword)}」的结果</span>`
    : '🎶 歌单<span class="sub">搜索主题歌单,例如:轻音乐</span>';
  if (!keyword) {
    el.main.innerHTML = `<div class="view-title">${title}</div>` + emptyBox('在顶部搜索框输入关键词开始探索');
    return;
  }
  el.main.innerHTML = `<div class="view-title">${title}</div>` + loadingBox();
  try {
    const lists = await api.searchPlaylists(keyword);
    if (!lists.length) {
      el.main.innerHTML = `<div class="view-title">${title}</div>` + emptyBox('未找到相关歌单,换个关键词试试');
      return;
    }
    const cards = lists.map(
      (p, i) => `
      <div class="card" data-i="${i}">
        <div class="card-play-hint">${coverImg(p.img, 480)}<button class="play-badge">▶</button><button class="card-add card-star" title="收藏到我的酷狗账号">☆</button></div>
        <div class="card-name">${escapeHtml(p.specialname)}</div>
        <div class="card-sub">${escapeHtml(p.nickname)}${p.playCount ? ` · ${Number(p.playCount).toLocaleString()}次播放` : ''}</div>
      </div>`
    );
    el.main.innerHTML = `<div class="view-title">${title}</div><div class="card-grid">${cards.join('')}</div>`;
    bindCoverFallback(el.main);
    el.main.querySelectorAll('.card').forEach((c) => {
      const pl = lists[Number(c.dataset.i)];
      c.addEventListener('click', () => renderPlaylistSongs(pl));
      // ☆ 收藏到酷狗账号:stopPropagation,别把点击穿给「进歌单」
      c.querySelector('.card-star')?.addEventListener('click', (e) => {
        e.stopPropagation();
        collectPlaylistToKuGou(pl);
      });
    });
  } catch {
    el.main.innerHTML = `<div class="view-title">${title}</div>` + emptyBox('加载失败');
    toast('无法连接音乐服务,请稍后重试', true);
  }
}

/** 歌单曲目(m.kugou 老接口仅前 10 首;私有歌单提示无法获取) */
async function renderPlaylistSongs(list, opts = {}) {
  const backLabel = opts.backLabel || '‹ 返回歌单';
  const onBack = opts.onBack || (() => renderPlaylistSearch(pendingSearch));
  const back = () => el.main.querySelector('.back-btn')?.addEventListener('click', onBack);
  el.main.innerHTML =
    `<div class="view-title"><button class="back-btn">${escapeHtml(backLabel)}</button> ${escapeHtml(list.specialname)}</div>` + loadingBox();
  back();
  try {
    const { name, songs, error } = await api.getPlaylistSongs(list.specialid);
    const title = name || list.specialname;
    if (error) {
      el.main.innerHTML =
        `<div class="view-title"><button class="back-btn">${escapeHtml(backLabel)}</button> ${escapeHtml(title)}</div>` + emptyBox(error);
      back();
      toast(error, true);
      return;
    }
    const isLink = /^https?:/i.test(String(list.specialid || ''));
    renderSongListView(songs, title, {
      sub: isLink ? `共 ${songs.length} 首 · 分享链接完整列表` : `共 ${songs.length} 首 · 接口仅提供前 10 首`,
      backLabel,
      onBack,
    });
  } catch {
    el.main.innerHTML =
      `<div class="view-title"><button class="back-btn">${escapeHtml(backLabel)}</button> ${escapeHtml(list.specialname)}</div>` + emptyBox('加载失败');
    back();
    toast('无法连接歌单服务', true);
  }
}

// ---------- 我的歌单(粘贴链接/歌单号添加,本地保存) ----------
const MY_KEY = 'vmp.myplaylists.v1';

function loadMyPlaylists() {
  try {
    const a = JSON.parse(localStorage.getItem(MY_KEY) || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

function saveMyPlaylists(list) {
  try {
    localStorage.setItem(MY_KEY, JSON.stringify(list));
  } catch {
    /* 存储满等异常忽略 */
  }
}

/** 本地歌单卡曲目数与实际(localMusic 状态)同步:加入/移除在线歌后调用 */
function syncLocalPlaylistCounts() {
  const mine = loadMyPlaylists();
  let dirty = false;
  for (const p of mine) {
    if (!p.local) continue;
    const pl = localMusic.getPlaylists().find((x) => x.id === String(p.specialid).slice(6));
    const n = pl ? (pl.songIds?.length || 0) + (pl.onlineSongs?.length || 0) : p.count;
    if (n !== p.count) { p.count = n; dirty = true; }
  }
  if (dirty) saveMyPlaylists(mine);
}

async function renderMyPlaylists() {
  const mine = loadMyPlaylists();
  // 本地卡封面解析:自定义上传 > 歌单级 URL > 本地歌封面 > 歌单内首曲封面 > 空
  const imgs = await Promise.all(mine.map(async (p) => {
    if (!p.local) return p.img || '';
    const pl = localMusic.getPlaylists().find((x) => x.id === String(p.specialid).slice(6));
    if (!pl) return '';
    if (pl.customCover) return localMusic.getCustomCoverUrl(pl.id).catch(() => '');
    if (pl.img) return fixImgUrl(pl.img, 480);
    if (pl.coverId) return localMusic.getCoverUrl(pl.coverId).catch(() => '');
    const first = localMusic.getPlaylistSongs(pl).find((s) => (s.localId && s.cover) || s.img);
    if (!first) return '';
    return first.localId ? localMusic.getCoverUrl(first.localId).catch(() => '') : fixImgUrl(first.img, 480);
  }));
  el.main.innerHTML =
    '<div class="view-title">📁 我的歌单<span class="sub">粘贴分享链接/歌单号,或输入歌单名搜索 · 公开歌单即可播放</span></div>' +
    `<div class="my-add">
       <input id="my-input" type="text" placeholder="粘贴歌单分享链接/歌单号,或输入歌单名">
       <button id="my-add-btn">添加</button>
       <button id="my-play-local">▶ 播放本地文件</button>
       <button id="my-new-local">＋ 新建本地歌单</button>
     </div>` +
    (mine.length
      ? `<div class="card-grid">${mine
          .map(
            (p, i) => {
              const isLink = /^https?:/i.test(String(p.specialid || ''));
              const sub = p.local
                ? `本地 · ${p.count} 首`
                : `${p.count ? `${p.count} 首 · ` : ''}${isLink ? '分享链接' : `歌单号 ${escapeHtml(String(p.specialid))}`}`;
              return `
        <div class="card" data-i="${i}">
          <button class="card-remove" title="移除">✕</button>
          <button class="card-rename" title="重命名">✏️</button>
          <div class="card-play-hint">${coverImg(imgs[i], 480)}<button class="play-badge">▶</button></div>
          <div class="card-name">${escapeHtml(p.specialname)}</div>
          <div class="card-sub">${sub}</div>
        </div>`;
            }
          )
          .join('')}</div>`
      : emptyBox('还没有添加歌单:在酷狗 App 打开你的歌单 → 右上角分享 → 复制链接,粘贴到上方即可'));
  bindCoverFallback(el.main);
  $('my-add-btn').addEventListener('click', addMyPlaylist);
  $('my-play-local').addEventListener('click', playLocalFiles);
  $('my-new-local').addEventListener('click', createLocalPlaylist);
  $('my-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addMyPlaylist();
  });
  el.main.querySelectorAll('.card-remove').forEach((b) => {
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      removeMyPlaylist(Number(b.closest('.card').dataset.i));
    });
  });
  el.main.querySelectorAll('.card-rename').forEach((b) => {
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const card = b.closest('.card');
      const idx = Number(card.dataset.i);
      const nameEl = card.querySelector('.card-name');
      nameEl.innerHTML = `<input class="card-rename-input" value="${escapeHtml(loadMyPlaylists()[idx]?.specialname || '')}">`;
      const inp = nameEl.querySelector('input');
      inp.focus();
      inp.select();
      const commit = () => {
        if (!inp.isConnected) return; // Enter 提交后重渲染触发 blur,防二次提交
        const v = inp.value.trim();
        const mine = loadMyPlaylists();
        if (v && mine[idx] && v !== mine[idx].specialname) {
          mine[idx].specialname = v;
          saveMyPlaylists(mine);
        }
        renderMyPlaylists();
      };
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') renderMyPlaylists();
      });
      inp.addEventListener('blur', commit);
    });
  });
  el.main.querySelectorAll('.card').forEach((c) => {
    c.addEventListener('click', () => {
      const pl = loadMyPlaylists()[Number(c.dataset.i)];
      if (!pl) return; // 渲染与点击之间歌单被移除时防 renderPlaylistSongs(list.specialname) 崩溃
      if (pl.local) return renderLocalPlaylist(pl);
      renderPlaylistSongs(pl, {
        backLabel: '‹ 返回我的歌单',
        onBack: () => renderMyPlaylists(),
      });
    });
    // 本地歌单:点封面图 = 更换歌单封面(不触发打开歌单)
    c.querySelector('.card-play-hint img')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const pl = loadMyPlaylists()[Number(c.dataset.i)];
      if (!pl?.local) return;
      showCoverPicker(localMusic.getPlaylists().find((x) => x.id === String(pl.specialid).slice(6)));
    });
  });
}

/** 查重后写入「我的歌单」(本地歌单与分享歌单共用),返回是否插入成功 */
function insertMyPlaylist(entry) {
  const mine = loadMyPlaylists();
  if (mine.some((p) => String(p.specialid) === String(entry.specialid))) return false;
  mine.unshift(entry);
  saveMyPlaylists(mine);
  return true;
}

async function addMyPlaylist() {
  const input = $('my-input');
  const text = input.value.trim();
  if (!text) return toast('请先粘贴歌单链接或歌单号', true);
  const parsed = api.parsePlaylistInput(text);
  // 不是链接/歌单号 → 当歌单名搜索挑选(朋友常直接粘歌单名,不再死路提示)
  if (!parsed) return addMyPlaylistByName(text);
  input.disabled = true;
  $('my-add-btn').disabled = true;
  try {
    const { id, name, songs, error } = await api.getPlaylistSongs(parsed.id || '', parsed.url || '');
    if (error) {
      toast(error, true);
      return;
    }
    // 分享页无歌单名、无歌单号:以原始链接为持久化键,名字给默认值(可重命名)
    const key = id || parsed.id || parsed.url || '';
    const title = name || `分享歌单(${songs.length}首)`;
    if (!insertMyPlaylist({ specialid: key, specialname: title, img: songs[0]?.img || '', count: songs.length })) {
      return toast('这个歌单已添加过');
    }
    renderMyPlaylists();
    toast(`已添加「${title}」`);
  } catch {
    toast('无法连接歌单服务', true);
  } finally {
    input.disabled = false;
    $('my-add-btn').disabled = false;
  }
}

/** 输入不是链接/歌单号 → 按歌单名搜索,点卡片直接加入「我的歌单」 */
async function addMyPlaylistByName(keyword) {
  const title = `🎶 按名称找歌单<span class="sub">「${escapeHtml(keyword)}」→ 点卡片加入我的歌单</span>`;
  el.main.innerHTML = `<div class="view-title"><button class="back-btn">‹ 返回我的歌单</button> ${title}</div>` + loadingBox();
  const back = () => el.main.querySelector('.back-btn')?.addEventListener('click', renderMyPlaylists);
  back();
  try {
    const lists = await api.searchPlaylists(keyword);
    if (!lists.length) {
      el.main.innerHTML =
        `<div class="view-title"><button class="back-btn">‹ 返回我的歌单</button> ${title}</div>` +
        emptyBox('未找到相关歌单:请确认输入的是分享链接/歌单号,或换个歌单名再搜');
      back();
      return;
    }
    const cards = lists.map(
      (p, i) => `
      <div class="card" data-i="${i}">
        <div class="card-play-hint">${coverImg(p.img, 480)}<button class="play-badge">▶</button></div>
        <div class="card-name">${escapeHtml(p.specialname)}</div>
        <div class="card-sub">${escapeHtml(p.nickname)}${p.playCount ? ` · ${Number(p.playCount).toLocaleString()}次播放` : ''}</div>
      </div>`
    );
    el.main.innerHTML = `<div class="view-title"><button class="back-btn">‹ 返回我的歌单</button> ${title}</div><div class="card-grid">${cards.join('')}</div>`;
    back();
    el.main.querySelectorAll('.card').forEach((c) => {
      c.addEventListener('click', () => {
        const p = lists[Number(c.dataset.i)];
        if (!p) return;
        const mine = loadMyPlaylists();
        if (mine.some((x) => String(x.specialid) === String(p.specialid))) {
          toast('这个歌单已添加过');
          return renderMyPlaylists();
        }
        mine.unshift({ specialid: String(p.specialid), specialname: p.specialname, img: p.img || '', count: 0 });
        saveMyPlaylists(mine);
        toast(`已添加「${p.specialname}」`);
        renderMyPlaylists();
      });
    });
  } catch {
    el.main.innerHTML =
      `<div class="view-title"><button class="back-btn">‹ 返回我的歌单</button> ${title}</div>` + emptyBox('加载失败');
    back();
    toast('无法连接音乐服务,请稍后重试', true);
  }
}

async function removeMyPlaylist(i) {
  const mine = loadMyPlaylists();
  const removed = mine.splice(i, 1)[0];
  saveMyPlaylists(mine);
  if (removed?.local) {
    // 保护集 = 内存队列中的本地歌 + 当前播放歌(会话内权威;localStorage 队列是防抖镜像可能过期,
    // 重启后若队列引用已删 blob,播放时报「本地文件读取失败」+ forgetSong 自愈,可接受)
    const protectedIds = [
      ...player.getQueue().filter((s) => s.localId).map((s) => s.localId),
      player.getCurrent()?.localId,
    ].filter(Boolean);
    await localMusic.removePlaylist(String(removed.specialid).slice(6), { protectedIds });
  }
  renderMyPlaylists();
  toast(`已移除「${removed?.specialname || ''}」`);
}

// ---------- 本地音频 / 本地歌单 ----------
/** 文件选择:与 wallpaper.js 同模式(createElement input + onchange 后重置 value 可重选) */
function pickFiles(multiple) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,.mp3,.flac,.wav,.m4a,.aac,.ogg,.ape';
    input.multiple = !!multiple;
    input.onchange = () => {
      const files = Array.from(input.files || []);
      input.value = '';
      resolve(files);
    };
    input.click();
  });
}

/** 导入所选本地文件并整体替换队列播放(按钮「▶ 播放本地文件」;files 参数供测试直调) */
export async function playLocalFilesFromFiles(files) {
  if (!files?.length) return;
  try {
    const { songs, skipped } = await localMusic.importFiles(files);
    if (skipped.length) toast(`已跳过 ${skipped.length} 个文件`, true);
    if (!songs.length) return;
    player.setQueue(songs, 0);
    toast(`正在播放本地文件:${songs.map((s) => s.name).join('、')}`);
  } catch {
    toast('本地文件导入失败', true);
  }
}

async function playLocalFiles() {
  playLocalFilesFromFiles(await pickFiles(false));
}

/** 导入所选本地文件 → 建歌单 → 入「我的歌单」→ 立即播放(按钮「＋ 新建本地歌单」;files 供测试直调) */
export async function createLocalPlaylistFromFiles(files) {
  if (!files?.length) return;
  try {
    const { songs, skipped } = await localMusic.importFiles(files);
    if (skipped.length) toast(`已跳过 ${skipped.length} 个文件`, true);
    if (!songs.length) return;
    const name = songs.length > 1 ? `${songs[0].name} 等${songs.length}首` : songs[0].name;
    const pl = await localMusic.createPlaylist(name, songs.map((s) => s.localId), songs);
    insertMyPlaylist({ specialid: 'local:' + pl.id, specialname: name, img: '', count: songs.length, local: true });
    player.setQueue(songs, 0);
    toast(`已创建本地歌单「${name}」(${songs.length} 首)`);
  } catch {
    toast('本地文件导入失败', true);
  }
}

async function createLocalPlaylist() {
  createLocalPlaylistFromFiles(await pickFiles(true));
}

/** 本地歌单曲目页:本地歌 + 收入歌单的在线歌混合列表 */
function renderLocalPlaylist(pl) {
  const list = localMusic.getPlaylists().find((x) => x.id === String(pl.specialid).slice(6));
  const back = () => renderMyPlaylists();
  if (!list) {
    el.main.innerHTML =
      `<div class="view-title"><button class="back-btn">‹ 返回我的歌单</button> ${escapeHtml(pl.specialname)}</div>` +
      emptyBox('本地歌单数据缺失(文件可能已被移除)');
    el.main.querySelector('.back-btn').addEventListener('click', back);
    toast('本地歌单数据缺失', true);
    return;
  }
  const songs = localMusic.getPlaylistSongs(list);
  renderSongListView(songs, pl.specialname, {
    sub: `共 ${songs.length} 首 · 本地 + 在线`,
    backLabel: '‹ 返回我的歌单',
    onBack: back,
  });
}

// ---------- 登录 / VIP ----------
let qrTimer = null;

function setQrStatus(msg, warn = false) {
  el.qrStatus.textContent = msg;
  el.qrStatus.classList.toggle('warn', warn);
}

async function startQrFlow() {
  clearInterval(qrTimer);
  qrTimer = null;
  setQrStatus('正在获取二维码…');
  try {
    const { key, img } = await api.getQrKey();
    if (!key || !img) {
      setQrStatus('二维码获取失败,请重试', true);
      return;
    }
    el.qrImg.src = img;
    setQrStatus('请用酷狗音乐 App 扫码');
    qrTimer = setInterval(async () => {
      try {
        const st = await api.checkQrLogin(key);
        if (st === 4) {
          clearInterval(qrTimer);
          qrTimer = null;
          setQrStatus('登录成功 ✓');
          toast('登录成功');
          setTimeout(closeLoginModal, 600);
          refreshLoginState();
        } else if (st === 2) {
          setQrStatus('已扫码,请在手机上确认');
        } else if (st === 0) {
          setQrStatus('二维码已过期,重新获取…');
          startQrFlow();
        }
      } catch {
        /* 瞬时网络错误,下一轮重试 */
      }
    }, 2000);
  } catch {
    setQrStatus('二维码获取失败,请重试', true);
  }
}

function openLoginModal() {
  el.loginModal.classList.add('open');
  startQrFlow();
}

function closeLoginModal() {
  el.loginModal.classList.remove('open');
  clearInterval(qrTimer);
  qrTimer = null;
  el.qrImg.src = '';
}

/** VIP 数据字段名不确定,防御式提取:类型 + 到期时间(实测 vip_type=6/is_vip=1,到期时间为 'YYYY-MM-DD HH:mm:ss' 字符串) */
function formatVipLabel(d) {
  const t = d?.vip_type ?? d?.vipType ?? d?.type ?? d?.union_vip ?? '';
  const isVip = d?.is_vip === 1 || d?.is_vip === '1' || d?.is_vip === true || t === 1 || t === '1' || t === true || /vip/i.test(String(t));
  let label = isVip ? '👑 VIP' : '已登录';
  const exp = d?.expire_time ?? d?.vip_expire_time ?? d?.expireTime ?? d?.end_time ?? d?.vip_end_time;
  let dt = null;
  if (exp !== undefined && exp !== null && exp !== '') {
    const n = Number(exp);
    if (Number.isFinite(n) && n > 0) dt = new Date(n < 1e12 ? n * 1000 : n);
    else if (typeof exp === 'string') dt = new Date(exp.replace(' ', 'T'));
  }
  if (dt && !Number.isNaN(dt.getTime())) {
    const pad = (x) => String(x).padStart(2, '0');
    label += ` · ${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  }
  return label;
}

/** 登录态(入口 = 抽屉用户大标题;主页登录按钮已移除):未登录提示,已登录显示 VIP 徽章 */
async function refreshLoginState() {
  if (!api.hasLogin()) {
    updateDrawerUser(null);
    return;
  }
  // 已登录:VIP 详情失败(上游 502/风控)不得回退成「未登录」,显示「已登录」保留退出能力
  let vip = null;
  try { vip = await api.getUserVip(); } catch { vip = null; }
  updateDrawerUser(vip);
}

/** 抽屉用户大标题:未登录提示登录;已登录显示 VIP 徽章/已登录 */
function updateDrawerUser(vip) {
  const wrap = el.drawerUser;
  wrap.dataset.arm = '';
  if (!api.hasLogin()) {
    wrap.dataset.logged = '0';
    el.drawerUserTitle.textContent = '未登录';
    el.drawerUserSub.textContent = '点击登录酷狗账号 · VIP 歌曲可听';
    return;
  }
  wrap.dataset.logged = '1';
  let uid = '';
  try { uid = JSON.parse(localStorage.getItem('vmp.login.v1') || '{}')?.userid || ''; } catch { /* 忽略 */ }
  const sub = uid ? `UID ${uid} · 点击进入我的酷狗` : '点击进入我的酷狗';
  if (vip) {
    el.drawerUserTitle.textContent = formatVipLabel(vip);
    el.drawerUserSub.textContent = sub;
  } else {
    el.drawerUserTitle.textContent = '已登录';
    el.drawerUserSub.textContent = sub;
  }
}

/** 抽屉用户大标题:未登录 → 登录弹窗;已登录 → 进「我的酷狗」页(退出登录挪到该页内,不再两击退出) */
async function onDrawerUserClick() {
  if (el.drawerUser.dataset.logged !== '1') {
    openLoginModal();
    return;
  }
  el.drawerUser.dataset.arm = '';
  openDrawer();
  switchTab('browse'); // 用户页渲染在浏览面板的 #main 里:必须先切回浏览标签,否则页在隐藏面板中
  showView('user');
}

// ---------- 我的酷狗(账号信息 / 听歌排行 / 退出登录) ----------
/** 本地登录态里已有的 UID 兜底(上游账号接口不可用时也必须看得到 UID) */
function localLoginInfo() {
  try {
    return JSON.parse(localStorage.getItem('vmp.login.v1') || '{}') || {};
  } catch {
    return {};
  }
}

/** 听歌排行条目兼容取值:上游字段名跨版本不统一,逐个兜底(含 audio_info 嵌套) */
function rankRowHtml(it, i) {
  const a = it?.audio_info || it || {};
  const name = a.songname || a.name || a.filename || a.audio_name || it?.songname || it?.name || '未知歌曲';
  const artist = a.singername || a.author_name || a.singer || it?.singername || it?.author_name || '';
  const cnt = Number(it?.playcount || it?.play_count || it?.total_play_count || it?.count || a.playcount || 0);
  return `<div class="rank-row">
    <span class="rank-idx">${i + 1}</span>
    <span class="rank-name">${escapeHtml(String(name))}</span>
    <span class="rank-sub">${escapeHtml(String(artist))}</span>
    <span class="rank-cnt">${cnt ? cnt.toLocaleString() + ' 次' : ''}</span>
  </div>`;
}

/** /user/listen 返回体里真正的曲目数组(各版本层级不同,逐个兜底) */
function pickRankArray(d) {
  const cands = [d?.info, d?.list, d?.songs, d?.data?.info, d?.data?.list, d?.data];
  for (const c of cands) if (Array.isArray(c) && c.length) return c;
  return [];
}

async function renderUserPage() {
  const local = localLoginInfo();
  const uid = local.userid || '未知';
  if (!api.hasLogin()) {
    el.main.innerHTML =
      '<div class="view-title">👤 我的酷狗<span class="sub">账号信息 · 听歌排行</span></div>' +
      emptyBox('未登录 · 点击抽屉顶部大标题扫码登录');
    return;
  }
  // 先用本地登录态渲染骨架(UID 立刻可见),再按需补上游昵称/昵称/VIP 与听歌排行
  el.main.innerHTML =
    '<div class="view-title">👤 我的酷狗<span class="sub">账号信息 · 听歌排行</span></div>' +
    `<div class="user-card">
       <img class="user-avatar" id="user-avatar" alt="" src="">
       <div class="user-info">
         <div class="user-name" id="user-name">酷狗用户</div>
         <div class="user-sub" id="user-sub">UID ${escapeHtml(String(uid))}</div>
       </div>
       <button class="user-logout" id="user-logout" title="退出酷狗账号">退出登录</button>
     </div>
     <div class="user-actions">
       <button class="chip" id="user-refresh" title="重新拉取账号信息">刷新</button>
     </div>
     <div class="view-title" style="margin-top:18px">🎧 听歌排行<span class="sub">按播放次数排序</span></div>
     <div id="user-rank">${loadingBox()}</div>`;

  el.main.querySelector('#user-logout').addEventListener('click', async () => {
    await api.logoutKugou();
    refreshLoginState();
    toast('已退出登录');
    showView('recommend');
  });
  el.main.querySelector('#user-refresh').addEventListener('click', () => showView('user'));

  // 账号信息(失败只影响昵称/VIP 展示,UID 仍来自本地登录态)
  try {
    const info = await api.getUserDetail();
    if (info) {
      const name = info.nickname || info.username || info.nick_name || '酷狗用户';
      const avatar = info.pic || info.picture || info.headimg || '';
      const uname = el.main.querySelector('#user-name');
      const usub = el.main.querySelector('#user-sub');
      if (uname) uname.textContent = name;
      if (usub) {
        const upUid = info.userid || uid;
        const vipEnd = info.vip_end_time || info.vipendtime || '';
        usub.textContent = `UID ${upUid}${vipEnd ? ` · VIP ${String(vipEnd).slice(0, 10)}` : ''}`;
      }
      if (avatar) {
        const img = el.main.querySelector('#user-avatar');
        if (img) { img.src = avatar; img.hidden = false; }
      }
    }
  } catch { /* 上游 502/风控:保留本地 UID 展示 */ }

  // 听歌历史排行:list_type 0(本周)为空时再试 1(全部),两者都空才提示暂无
  const rankBox = el.main.querySelector('#user-rank');
  let rows = [];
  for (const type of [0, 1]) {
    try {
      rows = pickRankArray(await api.getListenRank(type));
    } catch {
      rows = [];
    }
    if (rows.length) break;
  }
  if (!rows.length) {
    rankBox.innerHTML = emptyBox('暂无听歌排行(多听几首再来看看)');
  } else {
    rankBox.innerHTML = rows.slice(0, 20).map((it, i) => rankRowHtml(it, i)).join('');
  }
}

/** 收藏他人歌单(歌单搜索卡片上的 ☆):未登录先提示,失败按上游 msg 反馈 */
async function collectPlaylistToKuGou(p) {
  if (!api.hasLogin()) {
    toast('请先登录酷狗账号(抽屉顶部大标题)', true);
    return;
  }
  toast(`正在收藏「${p.specialname}」…`);
  try {
    const r = await api.collectPlaylist({
      name: p.specialname,
      listid: p.specialid,
      gid: p.gid,
      createUserid: p.userid,
    });
    if (r?.status === 1) {
      toast(`已收藏「${p.specialname}」到酷狗账号`);
    } else {
      toast(r?.error || r?.msg || '收藏失败(酷狗未返回成功)', true);
    }
  } catch {
    toast('收藏失败,请稍后重试', true);
  }
}

// ---------- 搜索 ----------
function doSearch() {
  const kw = el.searchInput.value.trim();
  if (!kw) {
    toast('请输入搜索关键词');
    return;
  }
  showView(searchType, kw);
}

// ---------- 播放条 ----------
function updatePlayerbar() {
  const cur = player.getCurrent();
  const state = player.state;

  // 播放/暂停图标
  el.btnPlay.textContent = state === 'playing' ? '⏸' : '▶';
  el.npWrap.classList.toggle('playing', state === 'playing');

  // 进度与时长
  const dur = player.getDuration();
  const pos = player.getPosition();
  el.timeDur.textContent = dur != null ? formatTime(dur) : '--:--';
  el.timeCur.textContent = formatTime(pos);
  if (dur != null) {
    el.seek.disabled = false;
    el.seek.value = String(pos);
    el.seek.max = String(dur);
  } else {
    el.seek.disabled = true;
    el.seek.value = '0';
  }
  const pct = dur ? (pos / dur) * 100 : 0;
  el.seek.style.setProperty('--fill', `${pct}%`);
}

/** 音量数字/滑杆/图标从 player 真值同步(快捷键、滑杆、静音按钮共用) */
function updateVolumeUI() {
  const v = Math.round(player.volume * 100);
  el.volume.value = String(v);
  el.volume.style.setProperty('--fill', `${v}%`);
  el.volumeNum.textContent = (player.muted ? 0 : v) + '%';
  el.btnMute.textContent = player.muted ? '🔇' : '🔊';
}

/** 播放模式按钮:图标 + 提示 + 状态标记(与兄弟钮同为灰,不再点亮薄荷色)。
 *  图标必须是单色 SVG 描边(currentColor 跟随按钮色):🔁/🔂/🔀 是彩色 emoji,
 *  由 Segoe UI Emoji 自带上色(蓝底白箭头),CSS 的 color 对它无效。 */
const MODE_UI = {
  order: {
    label: '顺序循环',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 5H8a4 4 0 0 0-4 4"/><path d="m17 2 3 3-3 3"/><path d="M4 19h12a4 4 0 0 0 4-4"/><path d="m7 22-3-3 3-3"/></svg>',
  },
  'loop-one': {
    label: '单曲循环',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 5H8a4 4 0 0 0-4 4"/><path d="m17 2 3 3-3 3"/><path d="M4 19h12a4 4 0 0 0 4-4"/><path d="m7 22-3-3 3-3"/><path d="M11.4 10.4 13 9.2V15"/></svg>',
  },
  shuffle: {
    label: '随机播放',
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h3.1a4 4 0 0 1 3.3 1.8l5.2 6.4A4 4 0 0 0 18 16h3"/><path d="m18 13 3 3-3 3"/><path d="M3 18h3.1a4 4 0 0 0 3.3-1.8l5.2-6.4A4 4 0 0 1 18 8h3"/><path d="m18 5 3 3-3 3"/></svg>',
  },
};

function updateModeBtn(mode) {
  const m = MODE_UI[mode] || MODE_UI.order;
  el.btnMode.innerHTML = m.icon;
  el.btnMode.dataset.mode = MODE_UI[mode] ? mode : 'order'; // 测试标记(图标是 SVG,textContent 恒为空)
  el.btnMode.title = `播放模式:${m.label} · 点击切换`;
  el.btnMode.classList.toggle('active', mode !== 'order');
}

function onSongChange({ song }) {
  el.npName.textContent = song?.name || '未在播放';
  el.npArtist.textContent = song?.artists || '从右侧挑选一首歌开始音乐之旅';
  el.npName.classList.toggle('marquee', (song?.name || '').length > 20);
  applySongCover(song);
  el.timeCur.textContent = '00:00';
  el.timeDur.textContent = song?.duration != null ? formatTime(song.duration) : '--:--';
  markPlayingRows(songKey(song));
  lyricsView.loadFor(song && !song.local ? song : null); // 本地歌无歌词源,不发空 hash 检索
  fillCoverFallback(song);
}

/** 播放条 + 歌词抽屉封面统一设置(无歌清空,无图落占位音符;本地歌从 IDB 现取) */
function applySongCover(song) {
  if (song?.local && song.cover) {
    el.npCover.src = el.lyricCover.src = PLACEHOLDER_IMG;
    const tok = (song._coverReq = (song._coverReq || 0) + 1);
    localMusic.getCoverUrl(song.localId).then((u) => {
      if (tok !== song._coverReq || player.getCurrent() !== song || !u) return;
      el.npCover.src = u;
      el.lyricCover.src = u;
    }).catch(() => { /* 保持占位图 */ });
    return;
  }
  const src = song ? fixImgUrl(song.img, 240) || PLACEHOLDER_IMG : '';
  el.npCover.src = src;
  el.lyricCover.src = src;
}

/**
 * 封面补全:分享歌单/部分歌单号导入的歌没有封面(img 为空),
 * 先凭 album_id 走 /images(hash+album_id),拿不到再用词曲检索兜底。
 * 结果写回 song.img(队列/后续渲染共享),按需只查一次。
 */
async function fillCoverFallback(song) {
  if (!song || song.img || song.local) return; // 本地歌封面走 IDB,不发 /images、词曲网络检索
  const token = (song._coverReq = (song._coverReq || 0) + 1);
  let img = '';
  if (song.albumId) img = await api.getSongCover(song.hash, song.albumId);
  if (!img) {
    try {
      const hits = await api.searchSongs(`${song.name} ${song.artists}`.trim());
      img = hits.find((h) => h.img)?.img || '';
    } catch { /* 网络异常保持占位图 */ }
  }
  if (token !== song._coverReq || !img) return; // 期间已切歌,丢弃过期结果
  song.img = img;
  if (player.getCurrent() === song) applySongCover(song);
}

// ---------- 歌词抽屉 ----------
function toggleLyric(force) {
  const open = force != null ? force : !el.lyricDrawer.classList.contains('open');
  el.lyricDrawer.classList.toggle('open', open);
  if (open && !player.getCurrent()) lyricsView.loadFor(null);
}

// ---------- 初始化 ----------
export function initUI() {
  // 播放条/歌词抽屉封面失败兜底(CSP 下无内联 onerror;常驻监听,换 src 后同样受保护)
  [el.npCover, el.lyricCover].forEach((img) => {
    img.addEventListener('error', () => {
      if (img.src !== PLACEHOLDER_IMG) img.src = PLACEHOLDER_IMG;
    });
  });

  // 搜索
  el.searchBtn.addEventListener('click', doSearch);
  el.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });
  document.querySelectorAll('.st-btn').forEach((b) => {
    b.addEventListener('click', () => {
      searchType = b.dataset.type;
      document.querySelectorAll('.st-btn').forEach((x) => x.classList.toggle('active', x === b));
      el.searchInput.placeholder = searchType === 'album' ? '搜索专辑…' : searchType === 'song' ? '搜索歌曲…' : '搜索歌单…';
      if (pendingSearch) showView(searchType, pendingSearch);
    });
  });

  // 侧栏导航
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.addEventListener('click', () => showView(b.dataset.view));
  });

  // 右侧抽屉:边缘按钮 / 左上 logo / ✕ / Esc
  el.drawerTab.addEventListener('click', toggleDrawer);
  el.floatLogo.addEventListener('click', toggleDrawer);
  el.drawerClose.addEventListener('click', closeDrawer);
  document.querySelectorAll('.drawer-tab-btn').forEach((b) => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.rightDrawer.classList.contains('open')) closeDrawer();
  });

  // 播放条
  el.btnPlay.addEventListener('click', () => player.toggle());
  el.btnNext.addEventListener('click', () => player.next());
  el.btnPrev.addEventListener('click', () => player.prev());
  el.btnMode.addEventListener('click', () => player.cyclePlayMode());
  el.seek.addEventListener('input', () => player.seek(Number(el.seek.value)));
  el.volume.addEventListener('input', () => player.setVolume(Number(el.volume.value) / 100));
  el.btnMute.addEventListener('click', () => player.setMuted(!player.muted));
  el.lyricToggle.addEventListener('click', () => toggleLyric());
  el.lyricClose.addEventListener('click', () => toggleLyric(false));

  // 点击播放条歌曲名 → 打开面板并切到队列标签页(歌单界面)
  el.npName.addEventListener('click', () => {
    openDrawer();
    switchTab('queue');
  });

  // 抽屉沉浸模式:主区出现返回按钮(歌曲列表页)时,隐藏抽屉头部/搜索/标签页/导航,
  // 让整个右侧面板进入歌单页面(返回后自动恢复)
  const syncChrome = () => {
    el.rightDrawer.classList.toggle('immersive', !!el.main.querySelector('.back-btn'));
  };
  syncChrome();
  new MutationObserver(syncChrome).observe(el.main, { childList: true, subtree: true });

  // 播放器事件 → UI
  player.on('statechange', updatePlayerbar);
  player.on('timeupdate', (t) => {
    updatePlayerbar();
    if (el.lyricDrawer.classList.contains('open')) lyricsView.update(t);
  });
  player.on('songchange', onSongChange);
  player.on('toast', (msg) => toast(msg, true));
  player.on('volumechange', updateVolumeUI);
  player.on('playmodechange', updateModeBtn);
  updateModeBtn(player.getPlayMode()); // 初始图标(含 localStorage 恢复的模式)
  player.on('queuechange', ({ index }) => {
    const cur = player.getCurrent();
    if (cur) markPlayingRows(songKey(cur));
    if (activeTab === 'queue') renderQueue();
  });

  // 登录 / VIP(入口 = 抽屉用户大标题;主页登录按钮已移除)
  el.drawerUser.addEventListener('click', onDrawerUserClick);
  el.loginClose.addEventListener('click', closeLoginModal);
  el.loginModal.addEventListener('click', (e) => {
    if (e.target === el.loginModal) closeLoginModal();
  });
  refreshLoginState();

  // 音量初始值
  player.setVolume(Number(el.volume.value) / 100);
  updateVolumeUI();
  updatePlayerbar();
  showView('recommend');
}
