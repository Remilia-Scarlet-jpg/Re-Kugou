/**
 * RE:KG — 检查 AI 翻译链路是否就绪(只读,不改任何配置)
 * 用法: node scripts/check-llm-key.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ENV_KEY = 'REKG_LLM_KEY';
const mask = (v) => (!v ? '(未设置)' : v.length <= 9 ? `${v.slice(0, 2)}****` : `${v.slice(0, 5)}****${v.slice(-4)}`);

/** 从 HKCU\Environment 读持久化值(process.env 可能是设置之前的旧快照) */
function readUserEnv(name) {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`, 'i'));
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

const probe = async () => {
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
};

const main = async () => {
  console.log('');
  console.log('== 1. 密钥来源(优先级:环境变量 > 密钥文件)==');
  const persisted = readUserEnv(ENV_KEY);
  const inProcess = process.env[ENV_KEY] || '';
  console.log(`   ${ENV_KEY}(持久化) = ${mask(persisted)}`);
  console.log(`   ${ENV_KEY}(当前终端) = ${mask(inProcess)}`);
  const keyFile = path.join(process.env.APPDATA || '', 'REKG', 'llm-key.txt');
  let fileKey = '';
  try {
    fileKey = (readFileSync(keyFile, 'utf8').trim().split(/\r?\n/)[0] || '').trim();
  } catch {
    /* 没有文件就是空 */
  }
  console.log(`   密钥文件 ${existsSync(keyFile) ? keyFile : '(不存在)'} = ${mask(fileKey)}`);
  if (fileKey && !fileKey.startsWith('sk-')) console.log('   ⚠ 文件里第一行不是 sk- 开头,服务端会忽略它。');
  console.log(`   REKG_LLM_URL(持久化)   = ${readUserEnv('REKG_LLM_URL') || '(默认 DeepSeek)'}`);
  console.log(`   REKG_LLM_MODEL(持久化) = ${readUserEnv('REKG_LLM_MODEL') || '(默认 deepseek-chat)'}`);

  console.log('');
  console.log('== 2. 本地服务(:3001)==');
  const r = await probe();
  if (r?.reason === 'unreachable') {
    console.log('   3001 没在跑 —— 先启动 RE:KG(或 node server.js),再重跑本检查。');
    return;
  }
  console.log(`   返回: ${JSON.stringify(r).slice(0, 240)}`);
  if (r?.ok) {
    console.log('   → 就绪:去歌词抽屉点「译」即可。');
  } else if (r?.reason === 'nokey') {
    console.log('   → 服务进程没读到密钥:请完全退出应用后重新打开(环境变量只在启动时读取)。');
  } else {
    console.log('   → 密钥读到了但调用失败:检查密钥有效性/余额,或 REKG_LLM_URL、REKG_LLM_MODEL。');
  }
  console.log('');
};

main();
