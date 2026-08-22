/**
 * 打包 staging:build/staging/api = api 运行时闭包(裁剪版,~11MB)。
 * - 按 api/package-lock.json(v3)图遍历,从 10 个运行时依赖出发复制 node_modules 闭包,
 *   确定、离线、不碰 api 源码树(dev 依赖 typescript/@rolldown 等原生二进制永不入包)
 * - 产物经 electron-builder extraResources 原样入包(绕开 files 收集器的
 *   node_modules 依赖树过滤 —— 根 package.json 无依赖时收集器会剥掉全部 node_modules)。
 *   extraResources 的 from 必须是 build/staging 整层:builder 的 filter.js 硬编码拒绝
 *   relative === "node_modules" 的根级条目,node_modules 需作为子层(api/node_modules)
 *   才能通过过滤 —— 任何 filter pattern 都救不回根级 node_modules(实测三连败)
 * - 只删自己目录(build/staging),无其他副作用
 * 用法:node scripts/stage-app.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const API_DIR = path.join(ROOT, 'api');
// 注意:不能放 release/ 下 —— electron-builder 的 files 收集器会排除输出目录,
// 且会把 node_modules 按根依赖树过滤掉;放 build/ 并经 extraResources 原样入包
const STAGE = path.join(ROOT, 'build', 'staging');

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyDir(s, d);
    else copyFile(s, d);
  }
}

// ---------- 1. 重建 staging ----------
fs.rmSync(STAGE, { recursive: true, force: true }); // 只删自己的目录
const DST_API = path.join(STAGE, 'api');
fs.mkdirSync(DST_API, { recursive: true });

// ---------- 2. 复制 api 源码(不含 .git/docs/node_modules 全量) ----------
for (const name of ['app.js', 'server.js', 'main.js', 'index.js', 'package.json']) {
  copyFile(path.join(API_DIR, name), path.join(DST_API, name));
}
for (const name of ['module', 'util', 'public']) {
  copyDir(path.join(API_DIR, name), path.join(DST_API, name));
}

// ---------- 3. 按 lockfile 图复制 node_modules 运行时闭包 ----------
const apiPkg = JSON.parse(fs.readFileSync(path.join(API_DIR, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(API_DIR, 'package-lock.json'), 'utf8'));
if (lock.lockfileVersion < 2) throw new Error('unsupported lockfileVersion: ' + lock.lockfileVersion);
const pkgs = lock.packages || {};

const seen = new Set();
function walk(depName) {
  const key = 'node_modules/' + depName;
  if (seen.has(key)) return;
  seen.add(key);
  const entry = pkgs[key];
  if (!entry) {
    console.warn('[stage] not in lockfile:', key);
    return;
  }
  const src = path.join(API_DIR, key);
  if (!fs.existsSync(src)) {
    console.warn('[stage] missing dir:', key);
    return;
  }
  copyDir(src, path.join(DST_API, key));
  // npm 会自动安装 peer/optional 依赖,运行时同样需要,一并跟随
  for (const sub of Object.keys({ ...entry.dependencies, ...entry.peerDependencies, ...entry.optionalDependencies })) {
    walk(sub);
  }
}
for (const dep of Object.keys(apiPkg.dependencies || {})) walk(dep);

// ---------- 4. 报告 ----------
let size = 0;
(function total(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) total(p);
    else size += st.size;
  }
})(DST_API);
const mb = (size / 1048576).toFixed(1);
const hasDev = ['@rolldown', '@oxc-project', 'typescript'].filter((n) =>
  fs.existsSync(path.join(DST_API, 'node_modules', ...n.split('/')))
);
console.log(`[stage] build/staging/api ready: ${mb} MB, ${seen.size} packages` +
  (hasDev.length ? `  WARN dev deps present: ${hasDev.join(', ')}` : '  (no dev deps)'));
