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

/** 制作署名行的英文写法:Produced by：Pdogg / Piano by：Hen / Guitar by: … */
const CREDIT_RE = /^[A-Za-z][A-Za-z .()'/&+-]{0,30}?\sby\s*[:：]/i;
function looksLikeCredit(body) {
  return CREDIT_RE.test(body);
}

/**
 * 译文行紧跟在原文行之后 → 并入 line.trans。
 * ⚠️ 只认「中文行」当译文(酷狗译文一律简体中文):早期版本只要求「语言类别不同」,
 * 结果把英文署名列当成了译文(实测 FAKE LOVE ⇒ "Produced by：Pdogg"),
 * 再叠加「有一行译文就整首不翻」,表现为「点了译也不翻」。署名行一律不参与配对。
 */
export function pairTranslations(lines, gapMax = 8) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    const nxt = lines[i + 1];
    if (nxt) {
      const gap = nxt.time - cur.time;
      const curCls = classifyText(cur.text);
      const nxtCls = classifyText(nxt.text);
      if (
        curCls !== 'zh' &&
        nxtCls === 'zh' &&
        gap >= 0 &&
        gap <= gapMax &&
        !isMetaLine(cur.text) &&
        !isMetaLine(nxt.text) &&
        !looksLikeCredit(cur.text) &&
        !looksLikeCredit(nxt.text)
      ) {
        cur.trans = nxt.text;
        i++; // 译文行不再单独占一条时间轴
      }
    }
    out.push(cur);
  }
  return out;
}

/**
 * 元信息署名行(歌词文件常带时间标签,不过滤会堆在歌词区顶部):
 * 中文「词/曲/编曲…:」+ 英文「Produced by：」两类。
 */
const META_LINE_RE =
  /^(?:(?:词|曲|作词|作曲|词曲|编曲|编曲人|词曲作者|演唱|歌手|和声|和音|合唱|演奏|制作|制作人|企划|企劃|原作|歌詞|作詞|作曲者|編曲|歌手|訳詞|翻訳|字幕|音乐|音楽|ボーカル|ギター|ベース|ドラム|ピアノ|キーボード|ストリングス|ヴァイオリン|チェロ|ホルン|コーラス|他編成|編成)\s*[:：]|[A-Za-z][A-Za-z .()'/&+-]{0,30}?\sby\s*[:：])/i;

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
    this.transError = ''; // 最近一次翻译失败原因(按钮据此显示重试态)
    this._lastTransToast = '';
  }

  /** 切歌时加载;失败静默降级为「暂无歌词」 */
  async loadFor(song) {
    this.songHash = song?.hash || null;
    this.song = song || null;
    this.transError = '';
    this._lastTransToast = '';
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
   * 判据从「有任一行译文就跳过」改成「覆盖率」:酷狗偶尔给一行半截译文(甚至把署名配成译文),
   * 旧的 some() 会让整首都不翻。现在只在 ≥60% 行已有译文时才认为接口自带双语;否则整首翻,只补空缺行。
   */
  async _maybeTranslate(song) {
    if (this.static || !this.lines.length) return;
    const total = this.lines.length;
    const have = this.lines.filter((l) => l.trans).length;
    if (have >= Math.max(2, Math.ceil(total * 0.6))) return; // 接口确实给了双语,不必再花钱
    if (!isTransOn()) return;
    const need = this.lines.filter((l) => !l.trans).map((l) => l.text);
    if (!needsTranslation(need)) return; // 中文歌不浪费额度
    const hash = song?.hash;
    const r = await translateLines(song, this.lines.map((l) => l.text));
    if (this.songHash !== hash) return; // 期间切歌
    if (!r?.ok) {
      this._transFail(r);
      return;
    }
    let filled = 0;
    this.lines.forEach((l, i) => {
      if (!l.trans && r.translations[i]) {
        l.trans = r.translations[i];
        l.aiTrans = true; // 标记来源:关掉开关时只清 AI 加的,不清接口自带的
        filled++;
      }
    });
    this.transError = '';
    if (filled) this._renderLines();
  }

  /** 翻译失败要有可读反馈(旧版只提示 nokey,密钥失效/超时/网络错误全是静默的) */
  _transFail(r) {
    const map = {
      nokey: '未配置翻译密钥 —— 点「译」打开设置窗',
      upstream: '翻译服务报错(密钥失效或额度用尽)',
      timeout: '翻译超时,稍后再点一次「译」',
      network: '连不上本地服务,确认 RE:KG 服务在跑',
      empty: '翻译结果为空,换个模型试试',
      error: '翻译失败',
    };
    const msg = map[r?.reason] || '翻译失败';
    this.transError = msg;
    if (this._lastTransToast === msg) return; // 同一原因不重复刷屏
    this._lastTransToast = msg;
    this.toast?.(msg);
  }

  /** 「译」按钮打开后重试:已有译文先渲染出来,缺的行再补(不再因「有一行」就整体跳过) */
  async retranslate() {
    this.transError = '';
    this._lastTransToast = '';
    if (this.lines.some((l) => l.trans)) this._renderLines();
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
