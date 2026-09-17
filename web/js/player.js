/**
 * 播放核心:队列 + 状态机 + URL 解析回退 + Web Audio 分析管线。
 *
 * 关键约定:
 * - 整个应用只有一个 <audio id="audio">,跨歌复用
 * - createMediaElementSource 只能调用一次(第二次抛 InvalidStateError),用 _graphBuilt 守卫
 * - trackercdn 返回的 mp3 地址带时间戳会过期 → 每次播放都重新解析,内存缓存 10 分钟
 * - 所有异步步骤携带 playToken 竞态守卫,用户快速切歌时旧流程自动作废
 */
import * as api from './api.js';
import * as localMusic from './local-music.js';
import { CONFIG } from './config.js';
import { clamp, debounce } from './utils.js';

const URL_CACHE_TTL = 10 * 60 * 1000; // 解析结果缓存 10 分钟
const MAX_CONSECUTIVE_FAILS = 3;      // 连续失败达到该值停止自动跳下一首
const PLAY_MODES = ['order', 'loop-one', 'shuffle']; // 顺序循环 / 单曲循环 / 随机播放
const PLAY_MODE_KEY = 'vmp.playmode.v1'; // 播放模式持久化键(store.js 同款 vmp.<name>.v1 约定)
const VOLUME_KEY = 'vmp.volume.v1';     // 音量/静音持久化键(拖滑杆后刷新界面要还原上次的值)
const VOLUME_SAVE_DELAY = 300;          // 拖滑杆会连发 input,防抖写盘

class Player {
  constructor() {
    this.audio = document.getElementById('audio');
    this.queue = [];          // Song[]
    this.index = -1;          // 当前曲目下标,-1 = 未选择
    this.state = 'idle';      // idle | resolving | loading | playing | paused | error
    this.volume = 0.8;
    this.muted = false;
    this._token = 0;          // 竞态守卫
    this._fails = 0;          // 连续失败计数
    this._urlCache = new Map();
    this._graphBuilt = false;
    this._analyser = null;
    this._listeners = {};

    // 音量写盘:拖滑杆连发 input → 防抖;pagehide 再同步落一次,拖完立刻刷新也不丢
    const writeVolume = () => {
      try {
        localStorage.setItem(VOLUME_KEY, JSON.stringify({ volume: this.volume, muted: this.muted }));
      } catch { /* 存储不可用静默降级 */ }
    };
    this._volumeFlush = debounce(writeVolume, VOLUME_SAVE_DELAY);
    window.addEventListener('pagehide', writeVolume);

    this._loadPlayMode();
    this._loadVolume();
    this._bindAudioEvents();
  }

  /** 从 localStorage 恢复音量与静音(非法/损坏值回退默认 80%/未静音) */
  _loadVolume() {
    let volume = 0.8;
    let muted = false;
    try {
      const d = JSON.parse(localStorage.getItem(VOLUME_KEY) || 'null');
      if (d && Number.isFinite(d.volume)) volume = clamp(d.volume, 0, 1);
      if (d && typeof d.muted === 'boolean') muted = d.muted;
    } catch { /* 存储不可用:用默认值 */ }
    this.volume = volume;
    this.muted = muted;
    this.audio.volume = muted ? 0 : volume; // 元素默认 volume=1,必须显式落一次
    window.__APP_VOLUME = { volume, muted };
  }

  /** 防抖写盘 + pagehide 同步落盘(拖完滑杆立刻刷新也不丢) */
  _saveVolume() {
    window.__APP_VOLUME = { volume: this.volume, muted: this.muted };
    this._volumeFlush();
  }

  /** 从 localStorage 恢复播放模式(非法/损坏值回退顺序循环) */
  _loadPlayMode() {
    let mode = 'order';
    try {
      const saved = localStorage.getItem(PLAY_MODE_KEY);
      if (PLAY_MODES.includes(saved)) mode = saved;
    } catch { /* 存储不可用时默认顺序循环 */ }
    this.playMode = mode;
    window.__APP_PLAY_MODE = mode;
  }

  // ---------- 事件订阅(极简 emitter) ----------
  on(evt, fn) {
    (this._listeners[evt] ||= []).push(fn);
  }
  _emit(evt, payload) {
    (this._listeners[evt] || []).forEach((fn) => fn(payload));
  }

  // ---------- 内部:audio 事件 → 状态机 ----------
  _bindAudioEvents() {
    this.audio.addEventListener('playing', () => this._setState('playing'));
    this.audio.addEventListener('pause', () => {
      if (this.state !== 'loading' && this.state !== 'resolving') this._setState('paused');
    });
    this.audio.addEventListener('ended', () => this.next());
    this.audio.addEventListener('timeupdate', () => this._emit('timeupdate', this.audio.currentTime));
    this.audio.addEventListener('loadedmetadata', () => this._emit('durationchange'));
    this.audio.addEventListener('error', () => this._onAudioError());
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this._emit('statechange', s);
  }

  // ---------- Web Audio 分析管线(首次播放时惰性构建,须在用户手势栈内) ----------
  async _ensureGraph() {
    if (this._graphBuilt) {
      // 生命周期恢复兜底:曾挂起的上下文在再次播放(用户手势栈内)时恢复,防静音
      if (this._ctx?.state === 'suspended') this._ctx.resume().catch(() => {});
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return; // 无 Web Audio 环境则纯播放,不做可视化
    const ctx = new Ctx();
    this._ctx = ctx; // 生命周期挂起/恢复用(见 suspendGraph/resumeGraph)
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch { /* 用户手势缺失时保持静默 */ }
    }
    const src = ctx.createMediaElementSource(this.audio); // 仅此一次
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.75;
    src.connect(analyser);
    analyser.connect(ctx.destination);
    this._analyser = analyser;
    this._graphBuilt = true;
    this._emit('analyserready', analyser);
  }

  getAnalyser() {
    return this._analyser;
  }

  /** 内存优化:窗口隐藏且未播放时挂起 Web Audio 释放音频线程。
   *  播放中绝不挂起——挂起即静音,音乐必须在最小化后继续响。 */
  suspendGraph() {
    if (this._ctx && this._ctx.state === 'running' && this.state !== 'playing') {
      this._ctx.suspend().catch(() => {});
    }
  }
  /** 恢复可见时唤醒;resume 被自动播放策略拒绝时静默,下次播放手势栈内另有兜底 */
  resumeGraph() {
    if (this._ctx && this._ctx.state === 'suspended') {
      this._ctx.resume().catch(() => {});
    }
  }

  // ---------- 队列 ----------
  setQueue(songs, startIndex = 0) {
    if (!Array.isArray(songs) || !songs.length) return;
    this.queue = songs;
    this.index = clamp(startIndex, 0, songs.length - 1);
    this._emit('queuechange', { queue: this.queue, index: this.index });
    this._playIndex(this.index);
  }

  /** 播放队列中指定下标的歌;若与当前相同则不做任何事 */
  playAt(i) {
    if (i < 0 || i >= this.queue.length) return;
    if (i === this.index && this.audio.src) {
      // 同曲:恢复播放(可能处于暂停)
      this.audio.play().catch(() => {});
      return;
    }
    this._playIndex(i);
  }

  getCurrent() {
    return this.index >= 0 ? this.queue[this.index] : null;
  }

  getQueue() {
    return this.queue;
  }

  /** 从持久化恢复队列:只恢复 UI 状态,不自动播放(浏览器要求用户手势) */
  restoreQueue(items, index) {
    this.queue = items.slice(0, CONFIG.MAX_QUEUE_ITEMS);
    this.index = clamp(index, -1, this.queue.length - 1);
    if (this.index >= 0) {
      this._setState('paused');
      this._emit('songchange', { song: this.getCurrent(), index: this.index });
      this._emit('queuechange', { queue: this.queue, index: this.index });
    }
  }

  /** 预取某首歌的播放地址(后台,失败静默);传 song 对象(_resolveWithCache 读 song.hash/hash320) */
  prefetch(song) {
    if (!song?.hash) return;
    this._resolveWithCache(song).catch(() => {});
  }

  // ---------- 控制 ----------
  toggle() {
    if (this.state === 'playing') {
      this.audio.pause();
    } else if (this.getCurrent()) {
      // 恢复的队列还没有加载音源 → 走完整播放流程
      if (!this.audio.src) return this._playIndex(this.index);
      this.audio.play().catch(() => this._emit('toast', '请点击页面后重试播放'));
    }
  }

  next() {
    if (!this.queue.length) return;
    if (this._fails >= MAX_CONSECUTIVE_FAILS) return; // 连续失败,不再自动跳转
    const len = this.queue.length;
    let i;
    if (this.playMode === 'loop-one') {
      i = this.index; // 单曲循环:重播当前曲(失败保护由 _fails 兜底)
    } else if (this.playMode === 'shuffle' && len > 1) {
      do { i = Math.floor(Math.random() * len); } while (i === this.index); // 随机且不与当前重复
    } else {
      i = (this.index + 1) % len; // 顺序循环(队尾回队首)
    }
    this._playIndex(i);
  }

  prev() {
    if (!this.queue.length) return;
    // 播放超过 3 秒时回退到曲首,否则切上一首
    if (this.audio.currentTime > 3) {
      this.seek(0);
      return;
    }
    this._playIndex((this.index - 1 + this.queue.length) % this.queue.length);
  }

  // ---------- 播放模式:顺序循环 / 单曲循环 / 随机播放 ----------
  // 只影响 next() 的选曲,不触碰音频链与状态机;next() 由 ended 事件与 _failSong 自动续播调用
  getPlayMode() {
    return this.playMode;
  }

  setPlayMode(mode) {
    if (!PLAY_MODES.includes(mode)) return;
    if (this.playMode === mode) return;
    this.playMode = mode;
    try { localStorage.setItem(PLAY_MODE_KEY, mode); } catch { /* 存储不可用时静默降级 */ }
    window.__APP_PLAY_MODE = mode;
    this._emit('playmodechange', mode);
  }

  cyclePlayMode() {
    this.setPlayMode(PLAY_MODES[(PLAY_MODES.indexOf(this.playMode) + 1) % PLAY_MODES.length]);
  }

  seek(sec) {
    if (!Number.isFinite(this.audio.duration)) return;
    this.audio.currentTime = clamp(sec, 0, this.audio.duration);
  }

  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    this.audio.volume = this.muted ? 0 : this.volume;
    this._emit('volumechange');
    this._saveVolume();
  }

  setMuted(m) {
    this.muted = !!m;
    this.audio.volume = this.muted ? 0 : this.volume;
    this._emit('volumechange');
    this._saveVolume();
  }

  getPosition() {
    return this.audio.currentTime || 0;
  }

  getDuration() {
    return Number.isFinite(this.audio.duration) ? this.audio.duration : null;
  }

  // ---------- 核心:解析 URL 并播放 ----------
  async _playIndex(i) {
    const song = this.queue[i];
    if (!song || (!song.hash && !song.localId)) return;

    const token = ++this._token; // 一切异步步骤之前的竞态守卫
    this._ensureGraph(); // 惰性构建 Web Audio 管线(须在用户手势栈内,同步部分立即执行)
    this.index = i;
    this._fails = 0;
    this._setState('resolving');
    this._emit('songchange', { song, index: i });
    this._emit('queuechange', { queue: this.queue, index: i });

    if (song.localId) return this._playLocal(song, token); // 本地歌:绕过 URL 解析/换源

    let urls;
    try {
      urls = await this._resolveWithCache(song);
    } catch {
      if (token !== this._token) return;
      this._failSong('音源解析失败,请检查网络');
      return;
    }
    if (token !== this._token) return;

    if (!urls.length) {
      this._failSong('播放失败,该歌曲可能为VIP或已下架');
      return;
    }
    this._tryUrls(song, urls, 0, token);
  }

  /** 本地歌播放:IDB 懒取 blob → objectURL 直连;加载失败自愈(清元数据)后走失败流程 */
  async _playLocal(song, token) {
    const oldUrl = this._localUrl;
    let url;
    try {
      url = await localMusic.getPlayUrl(song.localId);
    } catch {
      if (token !== this._token) return;
      localMusic.forgetSong(song.localId); // blob 丢失(被 GC/清库):移除失效元数据
      this._failSong('本地文件读取失败,可能已被删除');
      return;
    }
    if (token !== this._token) return;
    this._pendingUrls = null; // 防 _onAudioError 误走换源逻辑
    this._setState('loading');
    this.audio.src = url; // 先设新 src
    // 再 revoke 旧(local-music.js 约定);同曲重播(单曲循环/单曲队列)复用同一 URL,不得 revoke
    if (oldUrl && oldUrl !== url) localMusic.releasePlayUrl(oldUrl);
    this._localUrl = url;

    // loadedmetadata 补时长(本地歌 song.duration 恒 null,getDuration 就绪前显示 --:--)
    const fill = () => {
      this.audio.removeEventListener('loadedmetadata', fill);
      if (token !== this._token || song.duration != null) return;
      if (Number.isFinite(this.audio.duration)) {
        song.duration = this.audio.duration;
        this._emit('queuechange', { queue: this.queue, index: this.index }); // 触发持久化补时长
      }
    };
    this.audio.addEventListener('loadedmetadata', fill);

    this.audio.play().catch(() => {
      if (token === this._token) this._emit('toast', '请点击页面后重试播放');
    });
  }

  _revokeLocalSrc() {
    if (this._localUrl) {
      localMusic.releasePlayUrl(this._localUrl);
      this._localUrl = null;
    }
  }

  /** 带 TTL 缓存的 URL 解析;已登录优先走登录音源接口(VIP/高音质),失败回退公开音源 */
  async _resolveWithCache(song) {
    const hash = song.hash;
    const cached = this._urlCache.get(hash);
    if (cached && Date.now() - cached.at < URL_CACHE_TTL) return cached.urls;
    const r = await api.resolvePlayUrl(hash);
    const fallback = r.urls || [];
    let urls = [];
    if (api.hasLogin()) {
      // 登录:优先 320k,拿不到再试 128k(均走 v5 明文 mp3)
      urls = await api.getSongUrlVip(song.hash320 || hash, '320');
      if (!urls.length) urls = await api.getSongUrlVip(hash, '128');
    }
    // 公开音源兜底:登录音源失效时免费曲仍可播
    urls = urls.concat(fallback.filter((u) => !urls.includes(u)));
    this._urlCache.set(hash, { urls, at: Date.now() });
    return urls;
  }

  /** 逐个尝试候选地址,error 事件驱动换下一个 */
  _tryUrls(song, urls, i, token) {
    if (token !== this._token) return;
    if (i >= urls.length) {
      this._failSong('播放失败,该歌曲可能为VIP或已下架');
      return;
    }
    this._setState('loading');
    this._pendingUrls = { song, urls, i, token };
    this._revokeLocalSrc(); // 本地 → 在线切换不泄漏 blob
    this.audio.src = urls[i];
    this.audio.play().catch(() => {
      if (token === this._token) this._emit('toast', '请点击页面后重试播放');
    });
  }

  _onAudioError() {
    const p = this._pendingUrls;
    if (p && p.token === this._token && p.i + 1 < p.urls.length) {
      // 当前地址失败 → 换下一个(只有 src 真正被加载才会触发 error)
      this._tryUrls(p.song, p.urls, p.i + 1, p.token);
    } else {
      this._failSong('播放失败,该歌曲可能为VIP或已下架');
    }
  }

  _failSong(msg) {
    this._setState('error');
    this._fails++;
    this._emit('toast', msg);
    this._revokeLocalSrc();
    this.audio.removeAttribute('src');
    this.audio.load();
    // 稍作停留后自动下一首(连续失败上限由 _fails 控制)
    setTimeout(() => {
      if (this.state === 'error') this.next();
    }, 800);
  }

  /** 切歌时清空歌词等派生状态的事件入口 */
  clear() {
    this._token++;
    this.audio.pause();
    this._revokeLocalSrc();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.queue = [];
    this.index = -1;
    this._setState('idle');
    this._emit('queuechange', { queue: [], index: -1 });
  }
}

export const player = new Player();
