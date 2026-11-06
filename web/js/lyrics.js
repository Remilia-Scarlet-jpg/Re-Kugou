/**
 * 歌词:LRC 解析 + 渲染 + 高亮跟随 + 点击 seek。
 */
import * as api from './api.js';
import { isTransOn, needsTranslation, translateLines } from './translate.js';
import { escapeHtml } from './utils.js';

/**
 * 解析 LRC 文本 → [{time(秒), text, trans?}],按时间升序;重复时间标签(副歌)会展开成多行。
 * skipLine(可选):body 文本谓词,返回 true 的行被过滤(用于剔除歌名重复行等元信息)。
 * 双语:酷狗外文歌的 LRC 把译文单独放成一行(紧跟在原文之后、时间戳约在原句结束处),
 * 这里按「相邻两行语言不同 + 间隔 ≤8s」合并成 line.trans,译文行从时间轴移除。
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
  return pairTranslations(lines);
}

/** 无时间轴歌词(酷狗 contenttype=2:原文/译文交替的纯文本)→ 静态行,time=null(不可 seek) */
export function parsePlainLyric(text, skipLine) {
  const rows = [];
  for (const raw of String(text || '').split(/\r\n|\r|\n/)) {
    const body = raw.replace(/^\s*(\[[^\]]*\]\s*)*/, '').trim();
    if (!body) continue;
    if (isMetaLine(body)) continue;
    if (skipLine && skipLine(body)) continue;
    const prev = rows[rows.length - 1];
    if (prev && !prev.trans && classifyText(prev.text) !== classifyText(body)) {
      prev.trans = body; // 原文 + 译文交替
      continue;
    }
    rows.push({ time: null, text: body });
  }
  return rows;
}

// ---------- 双语配对 ----------
const KANA_RE = /[\u3040-\u30ff]/;
const CJK_RE = /[\u3400-\u9fff]/;

/** 语言粗分类:假名 → ja;汉字 → zh;其余(英/韩/俄…)→ latin */
export function classifyText(s) {
  if (KANA_RE.test(s)) return 'ja';
  if (CJK_RE.test(s)) return 'zh';
  return 'latin';
}

/** 译文行紧跟在原文行之后:语言类别不同且时间差在 gapMax 秒内即视为译文,并入 line.trans */
export function pairTranslations(lines, gapMax = 8) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    const nxt = lines[i + 1];
    if (nxt) {
      const gap = nxt.time - cur.time;
      if (classifyText(cur.text) !== classifyText(nxt.text) && gap >= 0 && gap <= gapMax) {
        cur.trans = nxt.text;
        i++; // 译文行不再单独占一条时间轴
      }
    }
    out.push(cur);
  }
  return out;
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
    this.static = false;  // 无时间轴歌词:只展示不跟随、不可 seek
    this.song = null;     // 当前曲目(「译」按钮切换后要重试翻译)
  }

  /** 切歌时加载;失败静默降级为「暂无歌词」 */
  async loadFor(song) {
    this.songHash = song?.hash || null;
    this.song = song || null;
    this.lines = [];
    this.currentIdx = -1;
    this.static = false;
    if (!song) return this._renderEmpty('歌词');
    this.titleEl.textContent = `${song.name} - ${song.artists}`;
    this._renderLoading();

    let lyric = null;
    const meta = await api.searchLyric(song);
    if (meta) lyric = await api.getLyric(meta.id, meta.accesskey);
    if (this.songHash !== song.hash) return; // 期间已切歌

    // 剔除「歌名 - 歌手」这类标题重复行(与元信息行一道,不让它们堆在歌词区顶部)
    const skip = (body) => isTitleDupLine(body, song);
    this.lines = parseLRC(lyric, skip);
    if (!this.lines.length) {
      // 酷狗少数外文歌只给「原文/译文交替的纯文本」(contenttype=2,无时间戳):
      // 与其显示「暂无歌词」,不如静态展示双语对照(不可高亮/seek)
      const plain = parsePlainLyric(lyric, skip);
      if (plain.length) {
        this.static = true;
        this.lines = plain;
        this._renderLines();
        return;
      }
      this._renderEmpty('暂无歌词');
      return;
    }
    this._renderLines();
    this._maybeTranslate(song); // 不阻塞首屏:先出原文,译文到货再补
  }

  /**
   * 接口没给译文时按需 AI 翻译(开关在歌词抽屉头的「译」按钮)。
   * 只在「有外文行 / 还没有任何译文 / 开关打开」时才发请求;失败静默降级。
   */
  async _maybeTranslate(song) {
    if (this.static || !this.lines.length) return;
    if (this.lines.some((l) => l.trans)) return; // 接口自带双语,直接用
    if (!isTransOn()) return;
    if (!needsTranslation(this.lines.map((l) => l.text))) return; // 中文歌不浪费额度
    const hash = song?.hash;
    const r = await translateLines(song, this.lines.map((l) => l.text));
    if (this.songHash !== hash) return; // 期间切歌
    if (!r?.ok) {
      if (r?.reason === 'nokey') this.toast?.('未配置翻译密钥,见「使用说明 · AI 歌词翻译」');
      return;
    }
    this.lines.forEach((l, i) => {
      if (r.translations[i]) {
        l.trans = r.translations[i];
        l.aiTrans = true; // 标记来源:关掉开关时只清 AI 加的,不清接口自带的
      }
    });
    this._renderLines();
  }

  /** 「译」按钮打开后重试;已有译文直接重渲染 */
  async retranslate() {
    if (this.lines.some((l) => l.trans)) {
      this._renderLines();
      return;
    }
    await this._maybeTranslate(this.song);
  }

  /** 「译」按钮关掉:只移除 AI 加的译文,接口自带的保留 */
  clearTrans() {
    if (this.static) return;
    let changed = false;
    for (const l of this.lines) {
      if (l.aiTrans && l.trans) {
        delete l.trans;
        delete l.aiTrans;
        changed = true;
      }
    }
    if (changed) this._renderLines();
  }

  /** timeupdate 驱动:仅当前行变化时重渲染 */
  update(t) {
    if (!this.lines.length || this.static) return;
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
    this.song = null;
    this.lines = [];
    this.currentIdx = -1;
    this.static = false;
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
      .map((l, i) => {
        const t = l.time == null ? '' : ` data-t="${l.time}"`;
        const trans = l.trans ? `<span class="lyric-trans">${escapeHtml(l.trans)}</span>` : '';
        return `<div class="lyric-line" data-i="${i}"${t}>${escapeHtml(l.text)}${trans}</div>`;
      })
      .join('');
    // 点击任意行 → seek(无时间轴的静态歌词例外:没有可跳转的目标)
    this.bodyEl.querySelectorAll('.lyric-line[data-t]').forEach((el) => {
      el.addEventListener('click', () => this.onSeek(Number(el.dataset.t)));
    });
    this.currentIdx = -1;
  }
}
