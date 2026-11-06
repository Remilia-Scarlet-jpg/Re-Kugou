/**
 * 给 release APK 签名(AGP 产出的 app-release-unsigned.apk 是没有证书的,**手机装不上**)。
 *
 * 用法:node scripts/android-sign.mjs
 * 前置:android/rekg-release.jks(与 .pass 口令文件)已存在 —— 由 keytool 一次性生成。
 *
 * ⚠️ 这个 keystore 必须长期保留:Android 只允许「同签名」的包覆盖安装,
 *    换了密钥以后只能先卸载再装,应用数据(登录态/歌单/壁纸)会一起没。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KS = path.join(ROOT, 'android', 'rekg-release.jks');
const KS_PASS = path.join(ROOT, 'android', 'rekg-release.jks.pass');
const UNSIGNED = path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk');
const BUILD_TOOLS = path.join(ROOT, 'tools', 'build-tools', '36.0.0', 'apksigner.bat');

function die(msg) {
  console.error(`[sign] ${msg}`);
  process.exit(1);
}

if (!existsSync(UNSIGNED)) die(`找不到未签名包:${UNSIGNED}\n先跑 npx cap copy android && cd android && .\\gradlew.bat assembleRelease`);
if (!existsSync(KS)) die(`找不到密钥库:${KS}`);
if (!existsSync(KS_PASS)) die(`找不到口令文件:${KS_PASS}`);
if (!existsSync(BUILD_TOOLS)) die(`找不到 apksigner:${BUILD_TOOLS}`);

const pass = readFileSync(KS_PASS, 'utf8').trim();
if (!pass) die('口令文件是空的');

const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const out = path.join(ROOT, 'release', `REKG-${version}-arm64-release.apk`);

/**
 * ⚠️ 必须经 cmd.exe:Node 20+ 拒绝直接 spawn .bat/.cmd(抛 EINVAL)。
 * 不用 { shell: true } 是因为它会触发 DEP0190(参数不转义)—— 这里所有路径都无空格,`cmd /c` 足够安全。
 */
const CMD = process.env.ComSpec || 'cmd.exe';
const run = (args, opts) => execFileSync(CMD, ['/c', BUILD_TOOLS, ...args], opts);

run(
  [
    'sign',
    '--ks', KS,
    '--ks-key-alias', 'rekg',
    '--ks-pass', `pass:${pass}`,
    '--key-pass', `pass:${pass}`,
    '--out', out,
    UNSIGNED,
  ],
  { stdio: 'inherit' }
);

// 立即验签:签坏了当场发现,而不是等手机上「应用未安装」
const verify = run(['verify', '--print-certs', out], { encoding: 'utf8' });
if (!/DOES NOT VERIFY|ERROR/i.test(verify)) {
  const dn = (verify.match(/certificate DN: (.+)/) || [])[1] || '?';
  console.log(`[sign] OK → ${path.relative(ROOT, out)}(${dn})`);
} else {
  die(`验签失败:\n${verify}`);
}
