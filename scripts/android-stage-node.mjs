/**
 * Android 数据层 staging:把「桌面版的两个本地服务」装配成 capacitor-nodejs 能直接跑的 Node 工程。
 *
 * 产出目录:web/nodejs/(capacitor-nodejs 的 nodeDir 默认就取 <webDir>/nodejs)
 *   web/nodejs/
 *   ├── index.js        ← 生成:启动 api :3000(lite)+ server.js :3001
 *   ├── package.json    ← 生成:{ main: index.js }
 *   ├── server.js       ← 复制自根 server.js(静态服务 + /api/url + /api/playlist)
 *   ├── api/            ← 复制自 api/(含 node_modules,排除 .git / docs / 源码映射)
 *   └── web/            ← 复制自 web/(UI;排除 nodejs/ 自身,防递归)
 *
 * 为什么 Node 工程里要自带一份 web/:根 server.js 用 path.join(__dirname,'web') 定位静态目录,
 * 而 APK 里的 WebView 资产 Node 读不到(在 zip 里),所以必须把 UI 一起解出来。
 *
 * 用法:node scripts/android-stage-node.mjs [--dry]
 *   --dry  只打印计划,不落盘(沙箱里可验证逻辑)
 *
 * 注意:本脚本会写 web/nodejs/(已在 .gitignore),不会碰任何源码。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'web', 'nodejs');
const DRY = process.argv.includes('--dry');

/** 需要复制进来的 UI 顶层条目(排除 nodejs 自身)。
 *  error.html 是 Capacitor 的 server.errorPath 兜底页 —— 严格说只需要在 Capacitor 资产里,
 *  但让 staging 的 web/ 成为完整镜像,避免「本地起 Node 调试时看不到兜底页」的困惑。 */
const UI_ENTRIES = ['index.html', 'desktop-lyrics.html', 'error.html', 'css', 'js'];

/** 不复制进包的东西 */
const SKIP = new Set(['.git', 'docs', 'interface.d.ts', 'nodejs', '.cache', '.npm-cache']);

const skipName = (name) => SKIP.has(name) || name.endsWith('.map');

/**
 * 按 api/package.json 的 devDependencies 剪枝:typescript 22.5MB / prettier 10.7MB / @types 2.1MB
 * 这些只服务于开发,进 APK 纯属浪费(实测 node_modules 48.9MB → 剪枝后约 13MB)。
 */
const apiPkg = JSON.parse(readFileSync(join(ROOT, 'api', 'package.json'), 'utf8'));
const devDeps = Object.keys(apiPkg.devDependencies || {});
const devPrefixes = devDeps.map((n) => `api/node_modules/${n}`);
const relOf = (abs) => abs.slice(ROOT.length + 1).split(/[\\/]/).join('/');
const isDevOnly = (rel) => devPrefixes.some((p) => rel === p || rel.startsWith(`${p}/`));

/** api/ 的复制过滤器:跳过 .git/docs/源码映射 + 全部 devDependencies */
const apiFilter = (src) => {
  const rel = relOf(src);
  if (skipName(rel.split('/').pop())) return false;
  if (isDevOnly(rel)) return false;
  return true;
};

/** UI 的复制过滤器:只排除 nodejs(防递归)与 .map */
const uiFilter = (src) => {
  const name = relOf(src).split('/').pop();
  return name !== 'nodejs' && !name.endsWith('.map');
};

/** 只读:按过滤器预估体积(dry 模式用来验证剪枝效果) */
function measure(src, filter) {
  let total = 0;
  const stack = [src];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try { st = statSync(cur); } catch { continue; }
    if (!filter(cur)) continue;
    if (st.isDirectory()) { for (const n of readdirSync(cur)) stack.push(join(cur, n)); }
    else total += st.size;
  }
  return total;
}

const plan = [];

function copy(srcRel, destRel, filter) {
  const src = join(ROOT, srcRel);
  if (!existsSync(src)) {
    plan.push({ src: srcRel, dest: destRel, note: '跳过(源不存在)' });
    return;
  }
  plan.push({ src: srcRel, dest: destRel });
  if (DRY) return;
  cpSync(src, join(OUT, destRel), { recursive: true, filter: filter || ((s) => !skipName(s.split(/[\\/]/).pop())) });
}

// ---------- 生成入口 ----------
const ENTRY = `/**
 * Android 内嵌 Node 入口(capacitor-nodejs 自动执行本文件)。
 * 只做三件事:定平台参数 → 起酷狗 API(:3000)→ 起静态/代理服务(:3001)。
 * WebView 随后加载 http://localhost:3001,与桌面开发完全同源。
 */
process.env.platform = process.env.platform || 'lite'; // 概念版(lite)是硬规则,标准版搜不到专辑/歌单
process.env.HOST = process.env.HOST || '127.0.0.1';    // 只监听回环,与桌面一致
process.env.PORT = process.env.PORT || '3000';

/* 手机上没有 console 可看,统一挂到全局,便于通过 bridge 回传排查 */
globalThis.__REKG_NODE_LOG = [];
const log = (...a) => { const line = a.join(' '); globalThis.__REKG_NODE_LOG.push(line); console.log(line); };

try {
  require('./api/app.js');      // 起 3000(内部按 process.env.platform 选 lite)
  log('[rekg] kugou api started on', process.env.HOST + ':' + process.env.PORT);
} catch (e) {
  log('[rekg] kugou api failed:', e && e.message);
}

try {
  require('./server.js');       // 起 3001(静态 + /api/url + /api/playlist)
  log('[rekg] web server started on 3001');
} catch (e) {
  log('[rekg] web server failed:', e && e.message);
}
`;

const PKG = JSON.stringify(
  { name: 'rekg-node', version: '0.0.0', private: true, main: 'index.js', description: 'RE:KG Android 内嵌 Node 服务' },
  null,
  2
) + '\n';

// ---------- 执行 ----------
if (!DRY) {
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'index.js'), ENTRY, 'utf8');
  writeFileSync(join(OUT, 'package.json'), PKG, 'utf8');
}

copy('server.js', 'server.js');
copy('api', 'api', apiFilter);
for (const entry of UI_ENTRIES) copy(join('web', entry), join('web', entry), uiFilter);

if (!DRY) {
  // 体积报告:让"APK 里多出来多少"一目了然
  const sum = (p) => {
    let total = 0;
    const stack = [p];
    while (stack.length) {
      const cur = stack.pop();
      let st;
      try { st = statSync(cur); } catch { continue; }
      if (st.isDirectory()) {
        for (const n of readdirSync(cur)) stack.push(join(cur, n));
      } else total += st.size;
    }
    return total;
  };
  const mb = (n) => (n / 1024 / 1024).toFixed(1) + 'MB';
  console.log(`[stage-node] 产出 ${OUT}`);
  console.log(`[stage-node] 体积 ${mb(sum(OUT))}(其中 api/ 含 node_modules)`);
} else {
  console.log('[stage-node] --dry 计划:');
  for (const p of plan) console.log(`  ${p.src}  ->  web/nodejs/${p.dest}${p.note ? '  (' + p.note + ')' : ''}`);
  console.log('  (另生成 index.js 与 package.json)');
  const mb = (n) => (n / 1024 / 1024).toFixed(1) + 'MB';
  console.log(`[stage-node] 剪枝掉的 devDependencies: ${devDeps.join(', ') || '(无)'}`);
  console.log(`[stage-node] 预估体积 api/ = ${mb(measure(join(ROOT, 'api'), apiFilter))}`
    + `,web/ = ${mb(UI_ENTRIES.reduce((s, e) => s + measure(join(ROOT, 'web', e), uiFilter), 0))}`);
}
