/**
 * 歌词:LRC 解析 + 渲染 + 高亮跟随 + 点击 seek。
 */
import * as api from './api.js';
import { escapeHtml } from './utils.js';

/**
 * 解析 LRC 文本 → [{time(秒), text}],按时间升序;重复时间标签(副歌)会展开成多行。
 * skipLine(可选):body 文本谓词,返回 true 的行被过滤(用于剔除歌名重复行等元信息)。
 */
export function parseLRC(text, skipLine) {
  if (!text || typeof text !== 'string') return [];
  const lines = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const tags = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (!tags.length) continue;
    const body = raw.replace(/\[[^\]]*\]/g, '').trim();
    if (!body) continue; // 跳过纯元信息行与空行
    if (isMetaLine(body)) continue; // 词/曲/编曲等署名行不当作歌词
    if (skipLine && skipLine(body)) continue;
    for (const m of tags) {
      const t = Number(m[1]) * 60 + Number(m[2]) + Number(m[3] || 0) / 1000;
      lines.push({ time: t, text: body });
    }
  }
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

/** 元信息署名行(歌词文件常带时间标签,不过滤会堆在歌词区顶部):词/曲/编曲/演唱/制作等(中日) */
const META_LINE_RE =
  /^(?:词|曲|作词|作曲|词曲|编曲|编曲人|词曲作者|演唱|歌手|和声|和音|合唱|演奏|制作|制作人|企划|企劃|原作|歌詞|作詞|作曲者|編曲|歌手|訳詞|翻訳|字幕|音乐|音楽|ボーカル|ギター|ベース|ドラム|ピアノ|キーボード|ストリングス|ヴァイオリン|チェロ|ホルン|コーラス|他編成|編成)\s*[:：]/;

function isMetaLine(body) {
  return META_LINE_RE.test(body);
}

/** 标题重复行:「歌名」「歌名 - 歌手」「歌手 - 歌名」;与 LRC 顶部常见的第一行元数据相符 */
function isTitleDupLine(body, song) {
  if (!song?.name || !body) return false;
  const name = song.name;
  if (body === name) return true;
  if (body.startsWith(name) && /^\s*-\s/.test(body.slice(name.length))) return true;
  const artists = song.artists;
  if (artists && artists !== '未知歌手') {
    if (body === `${name} - ${artists}` || body === `${artists} - ${name}`) return true;
    if (body.startsWith(artists) && /^\s*-\s/.test(body.slice(artists.length)) && body.includes(name)) return true;
  }
  return false;
}

/** 二分查找当前行下标(未到时返回 -1) */
export function findLineIndex(lines, t) {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export class LyricsView {
  /**
   * @param {{title:HTMLElement, body:HTMLElement, onSeek:(sec)=>void, toast:(msg)=>void}} els
   */
  constructor({ title, body, onSeek, toast }) {
    this.titleEl = title;
    this.bodyEl = body;
    this.onSeek = onSeek;
    this.toast = toast;
    this.lines = [];
    this.currentIdx = -1;
    this.songHash = null; // 已加载歌词对应的曲目,避免旧请求覆盖
  }

  /** 切歌时加载;失败静默降级为「暂无歌词」 */
  async loadFor(song) {
    this.songHash = song?.hash || null;
    this.lines = [];
    this.currentIdx = -1;
    if (!song) return this._renderEmpty('歌词');
    this.titleEl.textContent = `${song.name} - ${song.artists}`;
    this._renderLoading();

    let lyric = null;
    const meta = await api.searchLyric(song);
    if (meta) lyric = await api.getLyric(meta.id, meta.accesskey);
    if (this.songHash !== song.hash) return; // 期间已切歌

    // 剔除「歌名 - 歌手」这类标题重复行(与元信息行一道,不让它们堆在歌词区顶部)
    this.lines = parseLRC(lyric, (body) => isTitleDupLine(body, song));
    if (!this.lines.length) {
      this._renderEmpty('暂无歌词');
      return;
    }
    this._renderLines();
  }

  /** timeupdate 驱动:仅当前行变化时重渲染 */
  update(t) {
    if (!this.lines.length) return;
    const idx = findLineIndex(this.lines, t);
    if (idx === this.currentIdx) return;
    this.currentIdx = idx;
    const prev = this.bodyEl.querySelector('.lyric-line.active');
    if (prev) {
      prev.classList.remove('active');
    }
    const target = this.bodyEl.querySelector(`[data-i="${idx}"]`);
    if (target) {
      target.classList.add('active');
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  clear() {
    this.songHash = null;
    this.lines = [];
    this.currentIdx = -1;
    this._renderEmpty('歌词');
  }

  // ---------- 渲染 ----------
  _renderLoading() {
    this.bodyEl.innerHTML = '<div class="lyric-empty">歌词加载中…</div>';
  }

  _renderEmpty(msg) {
    this.bodyEl.innerHTML = `<div class="lyric-empty">${escapeHtml(msg)}</div>`;
  }

  _renderLines() {
    this.bodyEl.innerHTML = this.lines
      .map(
        (l, i) =>
          `<div class="lyric-line" data-i="${i}" data-t="${l.time}">${escapeHtml(l.text)}</div>`
      )
      .join('');
    // 点击任意行 → seek;开唱前高亮第一行并滚到顶部
    this.bodyEl.querySelectorAll('.lyric-line').forEach((el) => {
      el.addEventListener('click', () => this.onSeek(Number(el.dataset.t)));
    });
    this.currentIdx = -1;
  }
}
