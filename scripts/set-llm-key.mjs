/**
 * RE:KG — AI 歌词翻译密钥设置(一次性)
 *
 * 用法:
 *   node scripts/set-llm-key.mjs                          # 交互式,粘贴 sk- 开头的密钥
 *   node scripts/set-llm-key.mjs --key sk-xxx             # 直接给
 *   node scripts/set-llm-key.mjs --use-harness-credential # 复用本机 DSH 已配置的密钥
 *
 * 做三件事:写「用户环境变量」REKG_LLM_KEY → 探一次本地 /api/translate → 打印后续步骤。
 * 密钥只在进程里经手,不写进仓库、不打印全文(只显示前后各 4 位)。
 */
import { createInterface } from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const ENV_KEY = 'REKG_LLM_KEY';
const mask = (v) => (!v ? '(空)' : v.length <= 9 ? `${v.slice(0, 2)}****` : `${v.slice(0, 5)}****${v.slice(-4)}`);
const argv = process.argv.slice(2);
const argVal = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** 用户级环境变量:setx 为主,失败回退 reg add(两者都写 HKCU\Environment) */
function setUserEnv(name, value) {
  try {
    execFileSync('setx', [name, value], { stdio: 'ignore' });
    return true;
  } catch {
    /* setx 不可用就回退注册表 */
  }
  try {
    execFileSync('reg', ['add', 'HKCU\\Environment', '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function readHarnessCredential() {
  const file = path.join(homedir(), '.dsh', '.credentials.yaml');
  if (!existsSync(file)) return null;
  const m = readFileSync(file, 'utf8').match(/sk-[A-Za-z0-9_-]{16,}/);
  return m ? m[0] : null;
}

async function probe() {
  try {
    const r = await fetch('http://127.0.0.1:3001/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: ['Hello world'] }),
      signal: AbortSignal.timeout(30000),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, reason: 'unreachable', error: e?.message || '连接失败' };
  }
}

const main = async () => {
  let key = argVal('--key') || '';

  if (argv.includes('--use-harness-credential')) {
    const found = readHarnessCredential();
    if (!found) {
      console.log('没能从 ~/.dsh/.credentials.yaml 读到密钥,请改用粘贴方式。');
      process.exitCode = 1;
      return;
    }
    key = found;
    console.log(`已从 DSH 配置读取密钥:${mask(key)}`);
  }

  if (!key) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log('');
    console.log('请粘贴你的密钥(DeepSeek 平台 → API keys,sk- 开头),回车确认:');
    key = (await rl.question(' 密钥: ')).trim().replace(/^["']|["']$/g, '');
    rl.close();
  }

  if (!key) {
    console.log('没有输入密钥,已取消。');
    process.exitCode = 1;
    return;
  }
  if (!key.startsWith('sk-')) {
    console.log(`这看起来不是 sk- 开头的密钥,已取消(收到:${mask(key)})。`);
    process.exitCode = 1;
    return;
  }

  const ok = setUserEnv(ENV_KEY, key);
  console.log('');
  if (!ok) {
    // 退路:系统环境变量写不进去(受限终端/安全软件/无注册表权限)→ 写密钥文件,server.js 会读它
    const dir = path.join(process.env.APPDATA || '', 'REKG');
    const file = path.join(dir, 'llm-key.txt');
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, `${key}\n`, { encoding: 'utf8', mode: 0o600 });
      console.log(`✓ 系统环境变量写不进(权限受限),已改写入密钥文件:${file}`);
      console.log('  server.js 在「没有环境变量」时会读这个文件,效果一样;删掉该文件即撤销。');
    } catch (e) {
      console.log('✗ 写入用户环境变量与密钥文件都失败了:', e?.message || e);
      console.log('  可手动添加:Win+R → rundll32 sysdm.cpl,EditEnvironmentVariables');
      console.log(`  变量名 ${ENV_KEY},值填你的密钥。`);
      process.exitCode = 1;
      return;
    }
  } else {
    console.log(`✓ 已写入用户环境变量 ${ENV_KEY} = ${mask(key)}`);
  }
  process.env[ENV_KEY] = key; // 让下面的探活用上新值

  console.log('');
  console.log('探一次本地服务(若它是在设置之前启动的,这里会显示 nokey —— 属正常):');
  const r = await probe();
  console.log(`  返回: ${JSON.stringify(r).slice(0, 240)}`);
  if (r?.ok) console.log('  → 服务已就绪,直接去歌词抽屉点「译」。');
  else if (r?.reason === 'nokey') console.log('  → 服务进程还没读到密钥:完全退出 RE:KG(确认没有 REKG.exe 残留)再重开。');
  else if (r?.reason === 'unreachable') console.log('  → 本地服务没在跑:启动 RE:KG 或 node server.js 后再跑 check-llm-key.mjs。');
  else console.log('  → 密钥读到了但调用失败:检查密钥是否有效/余额,或 REKG_LLM_URL、REKG_LLM_MODEL 是否写错。');

  console.log('');
  console.log('接下来:');
  console.log('  1) 完全退出 RE:KG(任务管理器确认没有 REKG.exe 残留),再重新打开');
  console.log('  2) 播放外文歌 → 歌词抽屉右上角点「译」');
  console.log('  3) 验证:node scripts/check-llm-key.mjs');
  console.log('');
};

main().catch((e) => {
  console.log('出错了:', e?.message || e);
  process.exitCode = 1;
});
