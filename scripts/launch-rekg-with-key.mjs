/**
 * RE:KG — 带 AI 翻译密钥启动(不需要写任何系统设置)
 *
 * 为什么不直接 setx:某些受限环境(PowerShell 沙箱 / 安全软件)不允许写 HKCU\Environment,
 * 而 Electron 主进程会把自身 env 透传给内嵌的 server.js —— 那么「启动时把密钥塞进子进程环境」
 * 就能达到同样效果,且密钥不落第二份明文。
 *
 * 用法:
 *   node scripts/launch-rekg-with-key.mjs             # 直接启动
 *   node scripts/launch-rekg-with-key.mjs --dry-run   # 只打印解析结果,不启动
 *
 * 密钥来源优先级:环境变量 REKG_LLM_KEY → 本机 DSH 配置 ~/.dsh/.credentials.yaml
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const DRY = process.argv.includes('--dry-run');
const REG_KEY = 'HKCU\\Software\\933a3e5c-ae60-54b8-8483-a68592c98fcb';
const mask = (v) => (!v ? '(空)' : v.length <= 9 ? `${v.slice(0, 2)}****` : `${v.slice(0, 5)}****${v.slice(-4)}`);

function installDir() {
  try {
    const out = execFileSync('reg', ['query', REG_KEY, '/v', 'InstallLocation'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/InstallLocation\s+REG_\w+\s+(.+)/i);
    if (m) return m[1].trim();
  } catch {
    /* 没装过就走默认路径 */
  }
  return path.join(process.env.LOCALAPPDATA || '', 'Programs', 'REKG');
}

function readKey() {
  if (process.env.REKG_LLM_KEY) return { key: process.env.REKG_LLM_KEY, from: '环境变量' };
  const file = path.join(homedir(), '.dsh', '.credentials.yaml');
  if (existsSync(file)) {
    const m = readFileSync(file, 'utf8').match(/sk-[A-Za-z0-9_-]{16,}/);
    if (m) return { key: m[0], from: '~/.dsh/.credentials.yaml' };
  }
  return null;
}

function running() {
  try {
    const out = execFileSync('tasklist', ['/fi', 'imagename eq REKG.exe', '/nh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return /REKG\.exe/i.test(out);
  } catch {
    return false;
  }
}

const dir = installDir();
const exe = path.join(dir, 'REKG.exe');
console.log('');
console.log('安装目录:', dir);
if (!existsSync(exe)) {
  console.log('✗ 这里没有 REKG.exe —— 先在同一个目录里确认安装位置(或先安装 REKG 1.2.0+)。');
  console.log('  可按需改注册表 InstallLocation,或把本脚本里的默认路径改成实际位置。');
  process.exitCode = 1;
  process.exit();
}

const found = readKey();
if (!found) {
  console.log('✗ 没有可用的密钥:既没有 REKG_LLM_KEY 环境变量,也没在 ~/.dsh/.credentials.yaml 里找到 sk- 开头的值。');
  console.log('  先跑:node scripts\\set-llm-key.mjs   (或把你的密钥贴进那个脚本)');
  process.exitCode = 1;
  process.exit();
}

console.log('密钥来源:', found.from, '->', mask(found.key));
console.log('REKG_LLM_URL:', process.env.REKG_LLM_URL || '(默认 DeepSeek)');
console.log('REKG_LLM_MODEL:', process.env.REKG_LLM_MODEL || '(默认 deepseek-chat)');

if (running()) {
  console.log('');
  console.log('⚠ 检测到 REKG.exe 已在运行 —— 它用的是启动时的旧环境。');
  console.log('  请先完全关闭 REKG,再跑本脚本,否则翻译仍会提示未配置。');
  if (!DRY) process.exitCode = 1;
  if (!DRY) process.exit();
}

if (DRY) {
  console.log('');
  console.log('(dry-run)以上是解析结果,未真的启动。去掉 --dry-run 即启动。');
  console.log('');
  process.exit();
}

const child = spawn(exe, [], {
  env: { ...process.env, REKG_LLM_KEY: found.key },
  detached: true,
  stdio: 'ignore',
});
child.unref();
console.log('');
console.log('✓ 已带密钥启动 RE:KG。播放外文歌 → 歌词抽屉点「译」。');
console.log('');
