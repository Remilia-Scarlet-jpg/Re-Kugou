# RE:KG — 项目规则(原「星际音乐」,2026-08-14 更名)

> 本文件是「RE:KG」(原「星际音乐」)项目的持久规则,任何会话在本项目工作前必须遵守。

## 项目定位

- 零依赖原生 ES 模块音乐播放器,无构建步骤;`web/` 由 `server.js`(:3001)静态服务
- 数据源 = 本地 KuGouMusicApi 源码版(`api\`,:3000),**酷狗音乐**
- 仅供学习交流,尊重版权、勿商用(此声明保留在所有用户可见文档中)

## 硬性约束(违反即出错)

1. **start.bat 必须保持纯 ASCII** — 中文 Windows 的 cmd 用 GBK 解析,UTF-8 中文注释会乱码执行失败
2. **数据源必须 `node app.js --platform=lite`(概念版模式)** — 标准版模式下专辑/歌单搜索返回空列表(实测回归)
3. **three.js 保持 r158 UMD**(`web/js/vendor/three.min.js`)— r158 是最后带 UMD 的版本,**勿升 r160+**
4. **绝不在真实 #starfield canvas 上探测 WebGL** — 上下文锁定会废掉 2D 回退;必须用一次性 probe canvas(main.js 现有模式)
5. **不要改 2D 回退引擎 visualizer.js 的配色** — 曾按 dataviz 校验器校准于其画布底色
6. **全站唯一允许的 border 是 .spinner 加载环** — Mac Dock 无边框 + 高透光玻璃是用户两次强调的硬需求
7. Electron 壳已交付(2026-08-13,NSIS 安装包):config.js `window.__APP_CONFIG__` 注入点已启用,细节见下方「Electron 壳」小节

## 安全加固不变量(2026-08 审计修复,20 项,勿回退)

- **监听收紧**:api/server.js HOST 默认 `127.0.0.1`(env HOST 覆盖);根 server.js `listen(PORT,'127.0.0.1')`;electron/main.js fork env 显式传 HOST。双服务不得绑 0.0.0.0
- **CORS 白名单**:api/server.js ALLOWED_ORIGINS Set {http://localhost:3001, http://127.0.0.1:3001}(`CORS_ALLOW_ORIGIN` env 可追加);命中才回精确 ACAO+Allow-Credentials,未命中不回 ACAO(OPTIONS 仍 204);根 server.js 不回任何 ACAO(全同源)
- **模块白名单(15 条)**:api/server.js 导出 `ALLOWED_MODULE_FILES` = recommend_songs / rank_list / rank_audio / search / album_songs / images / search_lyric / lyric / song_url / login_qr_key / login_qr_check / user_vip_detail / **playlist_add(收藏他人歌单)/ user_detail(账号信息)/ user_listen(听歌排行)**(**热搜 search_hot 于 2026-09-12 随功能移除摘除,`api/module/search_hot.js` 文件按惯例保留在盘、仅不注册 → 404**);api/main.js 同步过滤 + 跳过 `_` 前缀。**两处必须同步改**;新增前端路由 = 先加白名单再测。注册用 `app.all(route)` **精确匹配**(勿改回 app.use — prefix-mount 会让白名单的 /song/url 吞掉禁用的 /song/url/new,冒烟曾实测)
- **apicache 排除**:api/server.js 缓存中间件对 `/^\/(login|user|song|auth)\//` 路径跳过;依赖它的前端请求带 timestamp 参数(勿删)
- **SSRF 校验**:根 server.js `safeUpstreamUrl()`(new URL 解析、http/https、禁 userinfo、hostname === kugou.com 或 endsWith('.kugou.com'));upstreamGet **入口 + 每跳重定向**都校验,非法 `cb({ssrf:true})` → 调用方 502「非法上游地址」。勿把校验改回正则/子串判断(userinfo `kugou.com@127.0.0.1` 与伪子域均可骗过正则,审计实测)
- **trackercdn https**:根 server.js 模块级 `TRACKERCDN_HTTPS = true`(curl 实测 https 返回 200,0.42s);若大面积 502 先 curl -v 排查,再考虑回退并在此记录结论
- **登录 cookie**:api/server.js 身份/模块 cookie 统一后缀 `PATH=/; Max-Age=31536000; SameSite=Lax; HttpOnly`(https 加 Secure);服务端 `/auth/logout` 清 9 键(token/userid/vip_token/dfid/kugou_api_mid/guid/dev/mac/webgl);前端只写 localStorage `vmp.login.v1`,`hasLogin()` 判定;**严禁前端 document.cookie 写 token**(会再造非 HttpOnly 副本);migrateLegacyLogin(读旧 cookie 迁移 + 后台 /auth/logout)是唯一读 cookie 处,勿删
- **CSP**:index.html 与 desktop-lyrics.html head 各一份同一 meta;`connect-src 'self' data: blob: http://localhost:3000 http://127.0.0.1:3000` 的 **data: 与 blob: 缺一不可**(data: = wallpaper.js fetch(dataURL);blob: = S21b 封面 blob 回读,实测缺 blob: 时 S9 抓 CSP 违规);封面失败回退一律走 ui.js `bindCoverFallback(container)` 插入后绑定,禁内联 onerror 属性
- **错误脱敏**:api/util/request.js catch 只回 `String(e?.message || '请求失败')`;server.js 日志只打 `decode(req.path)`+状态码(不带 query/body);JSON 错误中间件回 `{status:0,msg:'请求无效'}` 剥 stack
- **弱随机**:api util(util.js/crypto.js)已全换 `crypto.randomBytes` 派生(字符集/长度/格式不变,getGuid 保留 v4 位);新代码生成凭据/随机串禁 Math.random
- **调试开关逃生门**:安装版默认 strip `--remote-debugging-port` 等 4 个开关;`REKG_ALLOW_DEBUG=1` 环境变量保留(仅测试机用,安装版 CDP 冒烟依赖它)
- **上游遗留三文件**:api/Dockerfile、api/vercel.json、api/.github/workflows/build.yml 已删除(git pull 会恢复 → 恢复即重删);api/package.json 已删 pkg 依赖/scripts/config 块
- 回归:web/ 文件按请求现读 → **回归运行期间勿改 web/ 任何文件**;安全断言在 S24 段(Node 直连断言服务端头,不经浏览器)

## Electron 壳(安装版,2026-08-13 交付)

- 结构:`electron/main.js`(主进程:utilityProcess 双服务 fork + 无边框主窗 + 桌词小窗拦截)+ `electron/preload.js`(注入 `__APP_CONFIG__`{electron,API_BASE,URL_API,PLAYLIST_API} 与 `vmpShell`)+ `web/js/electron-shell.js`(页面内拖拽条/窗口控件,浏览器模式零 DOM)+ `scripts/stage-app.js`(api 运行时闭包裁剪 staging)+ `scripts/gen_icon.js`(零依赖图标);根 `package.json` 的 `build` 键 = electron-builder NSIS 配置
- 硬规则:
  - api 子进程必须以 env `platform=lite` 运行(等价 `--platform=lite`,铁律 #2 不变);固定端口 3000/3001,启动前 net.connect 预检,占用则中文弹窗退出
  - **utilityProcess.exitCode 运行中是 `undefined` 而非文档所述 null(实测坑)**,判退出必须 `typeof exitCode === 'number'`
  - 退出必须 before-quit 显式 kill 双子进程(Windows 父进程退出不会杀子进程,否则端口残留)
  - 注入只经 preload(contextIsolation+sandbox 全开);页面不得拿 ipcRenderer 本体
  - 窗口控件/拖拽条零 border(铁律 #6 延续);**登录入口 = 抽屉用户大标题,主页右上角登录按钮已移除**;桌词小窗 = 无边框透明置顶 BrowserWindow(setWindowOpenHandler,页面 moveBy/7s 自关零改动)
  - 根 package.json **dependencies 必须留空**(防 electron-builder 误捆);api 依赖经 `npm run stage` 从 lockfile 图遍历入包;打包 = `npm run dist`;产物 `release\REKG Setup x.y.z.exe`;卸载保留 `%APPDATA%\REKG` 数据(旧版「星际音乐」数据目录由 main.js 启动时自动改名迁移)
  - **版本号规则(先生定调,每次打包前照此改 package.json version)**:每次修改 +0.0.1;patch 累计满 10 次进位 minor +0.1 且 patch 归零(如 1.0.9 的下一次 → 1.1.0);**当前基准 1.1.2**,下次打包应升为 1.1.3
  - 测试:安装版带 `--remote-debugging-port=9229` 启动 + `VMP_CDP_USE_EXISTING=1 node scripts/cdp_test.js`(attach 现有 target,/json/new 在 Electron 不可靠);dev 模式需 `ELECTRON_DISABLE_SECURITY_WARNINGS=1` 防 S9 误报
  - **本机环境坑:用户的 bash profile 全局设了 `ELECTRON_RUN_AS_NODE=1`**,CLI 启动 electron 必须 `env -u ELECTRON_RUN_AS_NODE`(否则以纯 Node 运行、require('electron') 返回路径字符串);资源管理器双击 exe 不受影响
  - 镜像:`.npmrc` 三 key(registry/electron_mirror/electron_builder_binaries_mirror 均 npmmirror),安装失败先查镜像
- 打包坑(2026-08-13 实测,勿重蹈):
  - **extraResources 带不进根级 node_modules**:builder 的 filter.js 硬编码拒绝 `relative === "node_modules"` 的根级条目,任何 filter pattern 都救不回(实测三连败)→ `from` 必须是 staging 整层(`build/staging` → resources/staging/api),node_modules 作为子层 api/node_modules 入包
  - **安装注册表键是 APP_GUID**:`HKCU\Software\933a3e5c-ae60-54b8-8483-a68592c98fcb`(= UUID.v5(appId) 派生,不是 com.vmp.starmusic);InstallLocation 在该键,后续安装位置由它复用
  - **安装文件夹名 = sanitizedName**(2026-08-14 更名后为 REKG;旧机注册表 InstallLocation 仍指向 star-music 则继续复用该目录);exe/卸载器名「REKG.exe」「Uninstall REKG.exe」
  - **Git Bash(MSYS2)会破坏 `/D=` 等安装器参数**(卸载器曾因此 no-op)→ 静默安装/卸载一律 PowerShell `Start-Process -ArgumentList '/S','/D=路径'`;卸载器 `/currentuser /S` 实测 exit=0 全清(保留 %APPDATA% 数据)
  - **`Error output: Can't open output file`(makensis exit 1)= 火绒实时防护锁住新生成的安装包**(2026-09-12 定位,1.0.7 与 1.1.1/1.1.2 均中过):症状 = `release\REKG Setup x.y.z.exe` 只写出 **~168 KB**(≈ NSIS stub 24 KB + 已签名卸载器 144 KB),同一轮的 `star-music-x.y.z-x64.nsis.7z`(102 MB)与 `REKG Setup x.y.z.__uninstaller.exe` 都是完整件 —— 即 makensis 在**追加 102 MB 载荷那一步**打不开输出。本机装有**火绒安全软件 6.0.11.2**(HipsDaemon/HipsTray),实时防护对刚创建的 exe 加锁。**勿误判为磁盘满**(实测 D: 空余 59 GB)或文件被占(失败后独占打开是成功的)。处置:①删掉截断的 `REKG Setup x.y.z.exe` 与 `.__uninstaller.exe` 后**重跑 `npm run dist`,通常一次即过**(1.1.1 在 20:21 重跑即出完整 97.94 MB)②根治:火绒 → 安全工具 → **信任区**添加 `D:\LittleProject\VisiableMusicPlayer`(至少 `release\`)与 `C:\Users\<用户名>\AppData\Local\electron-builder\Cache` ③排查:火绒「防护日志」看报错时刻前后有无拦截记录
  - 默认安装位置本机曾异常落到 D:\LittleProject(环境怪癖未查明)→ 静默安装显式 `/D=%LOCALAPPDATA%\Programs\REKG` 可控

## 架构地图

- 装配入口 `web/js/main.js`;`web/index.html` 的全部既有 id/class 必须保留(ui.js 绑定依赖)
- `player.js` — 单例事件总线:timeupdate/statechange/analyserready/queuechange/songchange/toast/volumechange/playmodechange;`playAt(i)`、`getQueue()` 已存在,勿重复实现;音频链 `_ensureGraph`/`_playIndex`/状态机不要动(播放模式只改 `next()` 选曲:`getPlayMode`/`setPlayMode`/`cyclePlayMode`,三态 order 顺序循环/loop-one 单曲循环/shuffle 随机播放,持久化 `vmp.playmode.v1`,标记 `window.__APP_PLAY_MODE`;`_playLocal` 同曲重播复用同一 objectURL 不 revoke——先设新 src 再 revoke 旧,勿改回)
- `ui.js`(约 800 行)— UI 单例:el 缓存 + 渲染函数;**新增 UI 一律走 MutationObserver 沉浸模式逻辑,勿手改各渲染函数**;播放条 `#btn-mode` 三态切歌模式(顺序循环/单曲循环/随机播放,**图标是单色描边 SVG**——🔁/🔂/🔀 是彩色 emoji,Segoe UI Emoji 自带上色,CSS 压不住;`dataset.mode` 是测试标记,`textContent` 恒空;**非顺序只留 `.active` 状态标记,配色与兄弟钮同为灰**);上/下一首 `#btn-prev`/`#btn-next` 为内联 SVG「单三角+竖条」(>| 与 |<,`fill: currentColor` 跟随按钮色);**登录入口 = 抽屉用户大标题 `#drawer-user`(主页右上角登录按钮已移除):未登录→登录弹窗,已登录→VIP 徽章/「已登录」,点击进入「我的酷狗」页(不再两击退出;退出登录 = 该页内 `#user-logout` 按钮)**;「我的酷狗」`renderUserPage()`(view 名 `user`):先用本地 `vmp.login.v1` 的 UID 渲染骨架(上游账号接口 502 也必须看得到 UID),再补昵称/头像/VIP 到期与听歌排行 `#user-rank`(字段名跨版本不统一,`rankRowHtml` 逐个兜底);歌单搜索卡右上角 ☆(`.card-add.card-star`)→ `collectPlaylistToKuGou()`,未登录只提示不发请求
- `lyrics.js` — parseLRC/findLineIndex/LyricsView;歌词同步链:audio timeupdate → player emit → ui.js 处理器(注意 ui.js 只在歌词抽屉打开时才调 lyricsView.update — 桌面歌词等新消费者需绕过此闸门或另接事件);**parseLRC 过滤元信息行**(`isMetaLine`:词/曲/编曲/演唱/制作等中日署名前缀)+ `skipLine` 谓词(loadFor 传 `isTitleDupLine` 剔除「歌名 - 歌手」标题重复行,防 LRC 顶部元信息堆满歌词区)
- `visualizer3d.js` — 模块级常量 PALETTE_IDLE/PALETTE_ENERGY/E_STEPS/N_ORB=1800/N_STARS=1500/N_RING=800;相机 = user 基准轨道 + cameraman 电影偏移(已接入 fx 管线);契约同 visualizer.js:constructor/setAnalyser/setPlaying/destroy + **setSuspended(生命周期挂起 rAF,恢复时重置时钟防大步进,2D 引擎同契约)**
- `lifecycle.js` — active⇄hidden 生命周期状态机(内存优化):双信号取或(document.visibilitychange + Electron minimize/restore IPC `app:hidden`);订阅方挂起重型子系统;**桌面歌词不接入**(心跳/推送必须跨最小化存活);测试钩子 `__APP_LIFECYCLE`/`__APP_LIFECYCLE_API.hide()/show()`
- `api.js` — 酷狗接口映射(lite 数据形状兼容);`server.js` — /api/url 与 /api/playlist 两个代理;账号侧新增 `getUserDetail`(→ /user/detail · v3/get_my_info)、`getListenRank`(→ /user/listen · v2/get_list)、`collectPlaylist`(→ /playlist/add · cloudlist v5/add_list,type=1=收藏既有歌单,三要素 listid/gid/创建者 userid 缺一上游即拒),三者都走 getJsonCred 带 cookie 且带 timestamp 破缓存
- `store.js`/`config.js` — localStorage 键名 `vmp.<name>.v1` + 防抖写盘模式
- **z 序**:wallpaper-layer → canvas(底)→ 右浏览抽屉 z4 → 歌词抽屉 z5 → toast/登录弹窗;playerbar z2;跨窗口通信 = BroadcastChannel `vmp-desktop-lyrics-v1`(桌词小窗)

## 数据源关键事实(酷狗)

- **API 全局 2 分钟响应缓存**(apicache)→ 轮询类请求必须带变化的 timestamp 参数破缓存,否则永远返回首次响应
- **歌曲搜索走 type=lyric 词曲检索通道**:lite 模式 `/search?type=song` 走 /v3 报 152(Parameter Error,实测),type=lyric 反而返回完整可播放元数据(FileHash 128k/320Hash/trans_param.ogg_320_hash/TimeLength 秒/Image {size} 占位)
- **封面补全走 /images 接口**:分享页(dataFromSmarty)解析出的歌只有 hash + album_id 无封面 → 前端播放时按需 `GET /images?hash=&album_id=&count=1`(android 签名接口,lite 可用),封面在 `data[0].album[0].sizable_cover`({size} 占位);server.js 分享/歌单号两路都保留 albumId 字段
- 登录:/login/qr/key 返回 base64 PNG(无需 QR 库)+ /login/qr/check?key=(status 4 时服务端 Set-Cookie token+userid);前端 fetch 走 credentials:'include'
- **每日推荐 = /recommend/songs**(module/recommend_songs → 上游 POST /everyday_song_recommend,everydayrec.service.kugou.com,白名单内):未登录 userid=0 返回通用推荐 30 首/天(status 1,含 songname/singerinfo/sizable_cover/time_length 秒),登录带 userid cookie 个性化;前端 `getRecommendSongs` 用 getJsonCred(credentials include + timestamp 破缓存)——两服务未启动时推荐页会报「无法连接音乐服务」,先查 3000/3001
- **VIP 播放**(登录后):/song/url(v5)带登录 cookie 返回 320k 明文 mp3;**勿用 /song/url/new(v6)— .mgg 加密格式,浏览器无法解码**;未登录勿调 /user/vip/detail(上游 502 刷控制台,前端已用 cookie 守卫)
- cloudlist 签名失效 → 「我的歌单」= 粘贴分享链接/歌单号(localStorage 'vmp.myplaylists.v1')
- App 分享短链(t1.kugou.com → wwwapi 分享页)可读完整列表(≤100 首):JSON.parse 前须方括号计数截取;需桌面 UA
- **新式概念版分享短链(t1.kugou.com → activity.kugou.com SPA 壳,URL 带 global_specialid=collection_...)**:页面无内嵌数据,走 pubsongscdn H5 签名接口 `/v2/get_other_list_file?appid=1058&type=0&module=playlist&page=N&pagesize=300&global_collection_id=...`(**单页最多回 300 首**,pagesize 传 1000 也只给 300 → 必须 page=1..N 翻页,不足一页/无新增即停,hash 去重防页边界重叠,上限 20 页);每首自带 cover/timelen(ms)/album_id;签名 = `md5(盐 + 按键排序 key=value 串 + 盐)`,盐 `NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt`,固定参数 {srcappid:2919, clientver:20000, clienttime/mid/uuid:毫秒时间戳, dfid:'-'},signature 放 query;参数集合勿改动(缺失即 1001/20006);需手机 UA。此前「超 1000 首未翻页」的结论已作废:2026-09-12 实测单页 300 是硬上限,已改为逐页取全量
- 播放地址 trackercdn.kugou.com v2 时好时坏 → 候选列表合并 + 自动顺延是设计行为,不是 bug
- **server.js 上游请求回调必须 once 防重**(2026-08-16 实测崩溃):upstreamGet 超时 destroy 后 socket 仍可再触发 error、且重试期间迟到事件不得二次回调,否则「分享链接无法打开」响应头已发出、重试成功后 finishShare 再写 → ERR_HTTP_HEADERS_SENT → 子进程退出 → Electron 壳 fatal 整个应用退出。upstreamGet/upstreamGetRetry 现均带 done 防重,勿删
- **安装版测试受系统锁屏影响**:Windows 锁屏(LockApp.exe 在跑)时页面 visibility=hidden、rAF 完全停摆 → S12d 相机漂移/FOV 断言必失败(3D 渲染暂停本身是产品设计行为,壁纸窗口不可见就不该烧 GPU);同环境下 **S23「透明度未被快照顶回」也会挂**(computed opacity 读的是 CSS transition 插值,hidden 窗口过渡时钟冻结停在中间值——滑杆逻辑值/拖动守卫/fx 回写等逻辑断言不受影响,2026-08-18 安装版两次 215/216 均为该单项);安装版全绿需要桌面处于解锁状态,失败前先查 LockApp.exe

## UI/视觉规范(Mineradio 2.1.0 设计语言)

- token:bg #08090b / paper #0e1014 / ink #e8ecef / muted #8a9099 / 主色 #00f5d4 薄荷 / #2442ff 蓝 / gold #f4d28a / visual-tint #9db8cf
- 玻璃配方:`linear-gradient(112deg, 左上亮 rgba(62,66,70,·) → 右下暗 rgba(8,12,14,·))` + `inset 0 1px 0 rgba(255,255,255,·)` 顶部高光 + 薄荷辉光阴影 + blur(12-14px) saturate(1.25);整体透明度 16%-34%(高透光,粒子可透)
- 卡片:radius 18-22px、渐变底、悬停 translateY(-3px) + 青色辉光;按钮/输入框无边框,聚焦用 box-shadow 光晕
- 3D 配色:待机薄荷/青蓝(PALETTE_IDLE,星场 0x9db8cf)、能量香槟金(PALETTE_ENERGY)

## 测试约定

- `node scripts/cdp_test.js` — Node 24 零依赖 WebSocket CDP 驱动,需双服务运行 + Chrome;当前 263 项全绿(S12a-f:视觉面板/预设槽/运镜/壁纸/桌词小窗;S14:视频壁纸大文件上限判定;S15:登录态持久化 localStorage+hasLogin;S16:歌单按名称搜索兜底;S17:歌曲搜索+点播;S18:分享歌单封面补全+歌词抽屉封面;S19:新式概念版分享链接全量曲目;S20:音量数字联动;S21:本地音频播放(合成 WAV+刷新回放);S21b:ID3 解析;S22:本地歌单+移除 GC;S23:桌词三修复(墙钟同步/字号连点/滑杆守卫/尺寸钳制);S24:安全断言(Node 直连 httpRaw 断言 CORS 白名单/禁用路由 404/SSRF 4 类绕过 502/三安全头/CSP meta connect-src 完整/Set-Cookie 属性//auth/logout 清 9 键/错误脱敏);S25:旧登录态迁移;S26:播放模式(btn-mode 三态切换/vmp.playmode.v1 持久化/ended 实际切歌行为,本地双曲队列不依赖网络);S27:本地歌单增强(在线歌加入歌单/hash 去重/＋弹层选择/自定义封面 blob 可读);S28:生命周期内存优化(hidden 壁纸视频摘 src 解码休眠/rAF 挂起时间冻结/Web Audio 未播放挂起/show 全唤醒+播放链正常,经 `__APP_LIFECYCLE_API` 同路径驱动);S1:热搜功能移除残留断言(抽屉无 #hot-chips/.hot-chips/.hot-label)+ S24 新增「已摘除路由 /search/hot → 404」;S29:界面调整(上/下一首 SVG「单三角+竖条」/模式钮单色 SVG 描边且与兄弟钮同灰/抽屉底边停在播放条上方/桌词小窗根节点无背景+文字描边/粒子效果开关:关→画布隐藏+rAF 挂起、开→恢复、持久化 vmp.fx.v1);S30:视觉面板四组可收缩(点标题折叠 .fx-group-body/持久化 `vmp.fxcollapsed.v1`/参数控件仍留 DOM)+ 播放条歌名容器裁切(`.np-meta{overflow:hidden}`,跑马灯不越「词」按钮);S31:我的酷狗页(登录态徽章副标题指向「我的酷狗」/点徽章进 `user` 视图而非两击退出/页面显示本地登录态 UID/退出按钮位于头像栏最右侧且常显(`.user-logout` 危险色)/听歌排行区占位/`api.collectPlaylist` 暴露/页内 `#user-logout` 清登录态并回推荐页);S32:桌词锁定(小窗未开时锁按钮隐藏/开窗后可见/点锁 → 主窗标记+按钮变 🔒+持久化 `vmp.desktopLyrics.v1.locked` **布尔值**(注意与 S25 的字符串断言区分)/小窗同步 `dataset.locked`+控件淡化+拖拽光标 default/**锁定后小窗控件 `pointer-events` 不得为 none(锁上仍要能解锁,先生实测回归项)**/**2s 时窗:合成 mousemove → `dataset.hit=1` 控制条淡入,静置后回 `hit=0` 淡出**/小窗 🔒 经 `toggle-lock` 回主窗解锁/关窗后按钮隐藏);S10:登录入口 = 抽屉用户大标题(主页 login-btn 已移除,未登录文案+点击开弹窗+二维码流程);小窗断言用第二 CDP 会话 attachTarget,**勿在页面内 fetch CDP 端口**,CORS 报错会污染 S9 审计)
- **安装版验证**:`REKG_ALLOW_DEBUG=1` + `--remote-debugging-port=9229` 启动安装版 + `VMP_CDP_USE_EXISTING=1 node scripts/cdp_test.js`(Chrome 回归 + 安装版同 263 项双绿为交付标准);**不带 REKG_ALLOW_DEBUG 时 9229 会被 strip**(CDP attach 失败先查该环境变量);attachTarget 已带重试(Electron 新 BrowserWindow 的 target 上 /json/list 有竞态,重开小窗偶发找不到)
- 测试要求**未登录态**(S10 走二维码弹窗路径);已登录态跑会因「点登录=退出确认」而失败
- .state-box 类 = 加载态与错误空态共用 → 轮询等待错误态时须排除含 .spinner 的加载态
- 操作 .nav-item/#search-input 前必须先 openDrawer()
- S9 审计豁免环境噪声(isEnvNoise):酷狗 CDN CORS/ERR_FAILED、trackercdn /api/url 504、酷狗搜索/列表上游 502/504(内容断言由各 S 段把关,审计只免日志);「存在可播行」与 S2/S3 播放进度类偶发失败属 trackercdn 上游抖动(节点下载慢 → loadedmetadata 迟迟不来),重跑即可;S2 播放条同步断言已改轮询(!paused + np 非未在播放 + 时长非 --:-- + 按钮 ⏸,15s,2026-08-14 加固,src 已设但 metadata/playing 晚到不再误报)
- **prefetch 必须传 song 对象**(`player.prefetch(song)`):`_resolveWithCache` 读 song.hash/hash320,曾误传裸 hash 导致每次切歌都发 `/api/url?hash=undefined` + 登录态 `/song/url` 无 hash 502 噪声(netwatch 堆栈定位,勿改回)
- 新功能 = 新增 S 段;跨页面状态用 `window.__APP_*` 标记暴露给测试

## 参考实现:Mineradio 2.1.0(本地 d:\LittleProject\Mineradio-2.1.0)

数据源不同(酷狗 vs 网易云/QQ/汽水/Spotify)是**唯一刻意差异**;UI 与功能对齐 Mineradio。可移植模式:
- **桌面歌词**:独立透明小窗 + 节流状态快照推送 + 客户端时间外推(不等逐帧);当前项目用 window.open 代替 Electron 窗口
- **电影运镜**:轨道 = user 基准 + cine 偏移(节拍 kick/慢正弦漂移);节拍事件 = attack/hold/release 包络 → smoothstep;FOV punch 代替真实推轨
- **DIY 控制台**:面板 = 声明式注册表(标签页→组→控件引用);状态 = 扁平 fx 对象;预设存档 = 命名快照 + 每字段归一化
- **壁纸**:DOM 媒体层在透明 WebGL canvas 之下,CSS 变量控制透明度;图片压缩为 WebP dataURL、视频存 IndexedDB blob

## 重构成果(2026-08 架构重组 + 四功能,已交付)

- 新增模块(依赖严格单向,无环):`fx.js` 视觉参数中枢(19 参数/归一化/订阅/300ms 防抖写 `vmp.fx.v1`/pagehide 同步落盘,标记 `window.__APP_FX`)→ `cameraman.js`(电影运镜纯数学)→ `fx-panel.js`(视觉标签页,声明式注册表 + 4 预设槽 `vmp.fxpresets.v1`)→ `wallpaper.js`(`vmp-wallpaper-v1` IDB + `vmp.wallpaper.v1`)→ `desktop-lyrics.js` + `desktop-lyrics-view.js` + `desktop-lyrics.html`(小窗)
- 桌面歌词:window.open 独立小窗 + BroadcastChannel(hello/state/heartbeat 2s/bye/setFx);150ms 节流快照 + 小窗时间外推;直接读 ui.js `lyricsView`(ui.js 抽屉闸门零改动);7s 无消息小窗自关;窗口位置写 `vmp.desktopLyrics.v1`;拖动:Electron 顶部条走 `-webkit-app-region:drag` 原生拖拽(view 跳过页面 moveBy——**app-region 与系统边缘 resize 互斥,拖动永不误触放大**;浏览器 popup 保留 moveBy + `window.open` features 加 `resizable=no` 防拉伸)
- 电影运镜:user 基准轨道 + cine 偏移(节拍 kick 快攻慢放/慢正弦漂移/FOV punch);帧率 <45 降载联动 `lowPower`
- DIY 控制台:面板「视觉」标签页(ui.js 仅 switchTab 两处改动);参数经 fx.js 热更新到 viz3d/wallpaper/桌词;2D 回退模式面板显示提示
- 壁纸:DOM 媒体层垫在透明 3D canvas 之下;图片 → WebP dataURL(两级降质,超限转 IDB)、视频 → IDB(**>1000MB 拒**,配额预检 estimate + persist() 防回收,>100MB 保存提示;**测试钩子 `__APP_WALLPAPER_MAX_VIDEO`(调小测拒绝)与 `setSaveHook`(拦截落库)**);CSS 变量 `--wp-opacity/--wp-zoom/--wp-blur`
- 测试:cdp_test.js 117 项(S12a-f + S14 + S15 + S16);启动参数含 `--disable-popup-blocking`(桌词小窗 window.open)
- **登录态持久化(2026-08-14)**:API 的 Set-Cookie 无 Max-Age(会话 cookie),浏览器/安装版一关即丢(用户实测重开要重新登录)→ `api.js` 的 `checkQrLogin` 在 status 4 时用响应体 token/userid 调 `persistLoginCookies` 重写 `max-age=31536000; path=/` 持久 cookie;**logoutKugou 按同名 path=/ 删除,勿单改一边**;Electron 默认 session 持久化 cookie,无需额外配置
- **歌单输入兜底(2026-08-14)**:`parsePlaylistInput` 识别不了(朋友常直接粘歌单名)→ `addMyPlaylist` 改道 `addMyPlaylistByName`(搜索歌单名、点卡片加入我的歌单),不再死路 toast「未识别到」;parse 提取链接后剥尾部中文标点 `[。!?;:,、]+`(聊天软件复制常带,否则服务端跳转失败)
- **更名 RE:KG(2026-08-14)**:productName/shortcutName/产物 exe 一律 **REKG**(Windows 文件名禁 `:`,显示名 RE:KG);appId 与 npm name(star-music)不变,保注册表升级路径;main.js 启动早期迁移 `%APPDATA%\星际音乐` → `%APPDATA%\REKG`;gen_icon.js 重绘酷狗风蓝白 RE 图标(SDF 手绘字形,无字体依赖);浏览器页 favicon 同为蓝底白 RE SVG
- **歌曲搜索(2026-08-14)**:搜索类型加「歌曲」钮(歌曲/专辑/歌单三选),api.js `searchSongs` 走 type=lyric 词曲检索通道(见数据源关键事实);ui.js `renderSongSearch` 卡片网格(歌手 · 时长),点卡片直接 `player.setQueue(songs, i)`;S17 三段测试
- **歌词抽屉封面 + 封面补全(2026-08-14)**:歌词抽屉头部加圆形封面(#lyric-cover);分享歌单等 img 为空的歌在 onSongChange 时按需补全 `fillCoverFallback`(先 /images(hash+album_id),再词曲检索兜底,结果写回 song.img,切歌令牌防过期结果);S18 七段测试
- **新式概念版分享链接(2026-08-16)**:用户朋友的新式分享短链(t1.kugou.com → activity.kugou.com SPA 壳)此前报「链接解析失败」;server.js 新增 h5Sign/fetchCollectionPlaylist(见数据源关键事实),proxyPlaylist url 分支在分享页正则之前检测 finalUrl 的 `global_specialid` 参数;S19 八段测试(145 首全量/自带封面/播放条封面)
- **本地音乐 + 音量数字 + 桌词三修复(2026-08-16)**:「📁 我的歌单」页双按钮(▶ 播放本地文件 / ＋ 新建本地歌单);`id3.js` 纯函数 ID3 解析(v2.3/v2.4/v1、4 种文本编码、APIC 二次定向读 ≤4MB、非 mp3 文件名回退,零网络);`local-music.js` 本地库(IDB `vmp-localmusic-v1` 存文件+封面、localStorage `vmp.localmusic.v1` 存元数据;localId `lm-*` 与在线 hash 并存,**queue 只持久化元数据,播放时从 IDB 懒取 blob**;objectURL memoize,换歌先设新 src 再 revoke;测试钩子 `__APP_LOCAL`/`__APP_LOCAL_API`);本地歌单卡 `specialid:'local:'+id` 与网络歌单共存,移除卡按引用 GC(保护集 = 内存队列 localId + 当前歌;blob 丢失靠 forgetSong 自愈);本地歌 img 恒 '' 不发 /images、无歌词检索;音量滑杆旁百分比数字(volumechange 订阅,滑杆/静音/快捷键三路联动,顺带修复 --fill 恒 0%);桌词三修复:**窗口尺寸钳制 ≤屏幕 80%**(重放+心跳保存两处钳制,Electron 壳删除 `resizable: false`)、**跨窗口同步改墙钟 Date.now**(两端同改,勿换回 performance.now,每窗 timeOrigin 不同)、**字号连点读本地 CSS 变量+发绝对目标值**(消除 fx.js 同值短路),透明度滑杆 dragging 守卫(快照流不顶回);测试 S20-S23:合成 WAV 页面内生成(8kHz/8bit,`u8` 视图写头,**勿直接索引 ArrayBuffer**);合成 ID3 只解析不播放防 S9 噪音;headless 下 window.open 尺寸被浏览器忽略,钳制断言走 features 参数拦截(`window.open` 临时包装);S20 起把 S19 网络队列快照存 `__queue0`(localStorage,S21 有 Page.reload 会清 window 变量),S23 收尾恢复,保证其后 S11 队列断言有行可验;透明度断言读 `--dl-opacity` 内联变量(computed 会被 reenter 动画插值)
- **窄屏歌词抽屉避让(2026-08-19)**:竖屏/窄视口(≈400 CSS px,DPR≈1.4 实测截图)下歌词末行曾越出 .lyric-drawer 底边压到播放条;修复三层:`.lyric-drawer` 加 `overflow:hidden`(圆角裁剪,内容永不越出玻璃卡片)、`.lyric-body` 显式 `min-height:0` + `overscroll-behavior:contain`(防 flex 自动最小尺寸未归零把容器撑出)、`@media(max-width:900px)` 内 `width:min(380px, calc(100vw - 24px)); bottom:108px`(窄屏压回可用宽 + 避让播放条 88px)
- **歌词元信息行过滤(2026-08-19)**:酷狗 LRC 顶部常带时间标签的元数据(「歌名 - 歌手」「词:」「曲:」「编曲:」…),曾被当歌词渲染堆在歌词区顶部(用户反馈「歌曲名称跑太上面」);parseLRC 内建 `isMetaLine`(中日词/曲/编曲/演唱/制作/乐器等署名前缀)+ `skipLine` 谓词(loadFor 传 `isTitleDupLine`:歌名/「歌名 - 歌手」/「歌手 - 歌名」),桌面歌词同样受益(lines 共用);纯函数签名兼容(第二参数可选,测试无直接依赖)
- **桌词拖动误触放大修复(2026-08-19)**:用户反馈「拖拽桌面歌词时整个边框自动变大」——根因:页面逐帧 `moveBy` 拖拽中鼠标落进窗口边缘 6px 命中带,Windows 把后续移动解释为拉伸窗口。修复:Electron 小窗 `#dl-drag` 加 `-webkit-app-region:drag`(手柄内控件 `.dl-ctrls` no-drag),view 在 Electron 模式跳过 moveBy 拖动(原生拖拽与系统 resize 互斥);浏览器 popup `window.open` features 增加 `resizable=no`。Electron 壳小窗仍保留 resizable(用户可在非 drag 区边缘手动调大小)
- **播放模式三态(2026-08-19)**:播放条 `.ctrl-row` 新增 `#btn-mode` 按钮(🔁顺序循环/🔂单曲循环/🔀随机播放,点击循环切换,非顺序模式点亮薄荷色 `.ctrl-mode.active`);`player.js` 只改 `next()` 选曲(`getPlayMode`/`setPlayMode`/`cyclePlayMode`,持久化 `vmp.playmode.v1`,标记 `window.__APP_PLAY_MODE`),音频链未动;顺带修复 `_playLocal` 同曲重播 bug(旧代码先 `_revokeLocalSrc` 再设 src,单曲/顺序单曲队列重播会复用已 revoke 的 objectURL → 必挂;现改为先设新 src、仅当 URL 不同才 revoke 旧,符合 local-music.js 头注释约定);测试 S26 十二项(三态切换/持久化/高亮/ended 实际切歌行为,本地双曲 WAV 队列零网络依赖)
- **登录入口迁移到抽屉(2026-08-19)**:主页右上角 `#login-btn` 删除(样式/.pointer-events/z-index 注释/body[data-electron] 让位规则一并清理);登录入口唯一 = 抽屉用户大标题 `#drawer-user`(未登录→点击开登录弹窗;已登录→VIP 徽章(`formatVipLabel`)+ UID 副标题 + 两击退出,与旧顶栏行为一致);登录态判定 `api.hasLogin()`(localStorage vmp.login.v1),VIP 详情查询失败(上游 502/风控)不回退成「未登录」显示「已登录」保留退出能力;测试 S10 同步改造(login-btn 移除断言 + drawer-user 入口 + 未登录文案)
- **本地歌单增强(2026-08-27)**:本地歌单可收入**在线歌**(推荐/搜索卡片 `.card-add` 角标、歌曲行 `.row-add` 尾钮 → `showAddToPlaylistUI` 玻璃弹层选歌单或新建);`local-music.js` 歌单新增 `onlineSongs` 内嵌条目(hash 去重)、`getPlaylistSongs` 本地+在线混合、`addSongToPlaylist`、封面三源 `setCustomCover`(上传图压缩 480×480 WebP 存 IDB key `plc-<id>`)/`setPlaylistCoverFromSong`(本地歌 coverId / 在线歌歌单级 img)/`getCustomCoverUrl`;封面优先级 自定义 > 歌单级 img > 本地歌 coverId > 首曲封面;「我的歌单」卡**点封面图**开 `showCoverPicker`(歌单内歌曲封面缩略图 + 本机图片上传);`syncLocalPlaylistCounts` 加歌后同步卡曲目数;测试 S27(在线歌入列/hash 去重/弹层加歌/自定义封面 blob 可读)
- **热搜功能移除(2026-09-12,随 1.1.1 打包)**:先生要求删除抽屉搜索框下方「🔥 热搜」词条(截图定位)。清理五处:①`web/index.html` 删 `<div class="hot-chips" id="hot-chips">` ②`ui.js` 删 el 缓存项 + `loadHotChips()` 函数 + `init` 调用 ③`api.js` 删 `getHotWords()` ④`style.css` 删 `.hot-chips`/`.hot-label`(⚠️ `.chip` 是关闭钮/桌词钮等共用类,**不可删**)⑤`api/server.js` `ALLOWED_MODULE_FILES` 摘除 `search_hot` → `/search/hot` 变 404(13 条 → 12 条;`api/module/search_hot.js` 按「白名单外模块保留在盘」惯例不删,与其余 ~157 条同处理)。测试:S1 原「热搜 chips ≥5」改为「无热搜容器残留」断言(项数持平),S24 加「/search/hot → 404」并把该路径标注为安全头探针(CORS/Cookie 中间件先于路由,未注册路径同样带头)
- **生命周期内存优化(2026-08-27)**:新模块 `lifecycle.js`(active⇄hidden 状态机,双信号取或:document.visibilitychange + Electron 主进程 minimize/restore → `app:hidden` IPC;测试钩子 `__APP_LIFECYCLE`/`__APP_LIFECYCLE_API.hide()/show()`,与真实信号同路径)。隐藏时挂起 ①壁纸视频:`pause + removeAttribute('src') + load()` 释放解码帧(「壁纸线程休眠」;objectURL 保留不 revoke——大视频恢复零 IDB 重读,解码帧才是内存大头,压缩源 blob 浏览器落盘管理)②可视化:3D/2D 同契约 `setSuspended` 停 rAF,恢复重置时钟防大步进 ③Web Audio:`player.suspendGraph()`(仅未播放时挂起,播放中绝不挂——挂起即静音,音乐必须最小化后继续响);恢复 `resumeGraph()` + `_ensureGraph` 播放手势栈内兜底;桌面歌词不接入(心跳/推送跨最小化存活);Electron `app:metrics` handle(getAppMetrics 工作集快照,量化验证用);测试 S28 十二项
- **界面调整五项(2026-09-12,先生截图定调)**:①上/下一首由 ⏮/⏭ 字形改为内联 SVG「单三角+竖条」(>| / |<,`index.html` 直写 svg,样式 `.ctrl svg{width:20px;height:20px;fill:currentColor}`,与兄弟钮同为灰;⚠️ 勿改回 emoji 字形)②播放模式钮 `.ctrl-mode.active` 改回灰(var(--text-2)),`.active` 仅作状态标记——test S26 改断言 `dataset.mode`(图标换成 SVG 后 `textContent` 恒空),配色/描边断言在 S29;**⚠️ 图标必须用单色 SVG:🔁/🔂/🔀 是彩色 emoji(Segoe UI Emoji 自带蓝底白箭头),CSS 的 `color` 对它无效——先生实测「颜色没变」就是这一条**,三态图标写在 ui.js `MODE_UI[].icon`(描边图标走 `.ctrl-mode svg{fill:none;stroke:currentColor}`,index.html 内联顺序循环 SVG 作初值,`data-mode="order"`;**此修正不单独进位,仍归 1.1.2 这一轮——先生 2026-09-12 定调:同一轮内的修正不重复 +0.0.1**) ③`.right-drawer` 上下收高 `top:12px→20px`、`bottom:12px→100px`(底边停在播放条上方:12+76+12),窄屏 `@media(max-width:900px)` 内 108px 与歌词抽屉对齐 ④桌词小窗改**无背景**(酷狗同款):`desktop-lyrics.css` 去掉 `#dl-root` 渐变底 + Electron 卡片圆角/投影,可读性改由 `--dl-outline`(深色多层 text-shadow)保证;**浏览器弹窗模式仍补深色底**(`html:not([data-electron])` 白底会看不见白字,勿删该兜底),Electron 透明窗(transparent:true)才是真无背景 ⑤视觉面板新增 `sceneEnabled`(「粒子效果」)总开关:`main.js` 用 `canvas.style.visibility` 隐藏 + `viz.setSuspended()` 挂起(与生命周期 hidden 取或,`winHidden || off`,互不覆盖;用 visibility 而非 display:none 是保画布可测尺寸、渲染器 resize 不受影响)。测试 S29 十三项
- **桌词锁定 + 鼠标穿透(2026-09-12 第三批,先生定调,含一轮返工)**:小窗控制条加 `#dl-lock`,主窗播放条加 `#dl-lock-btn`(仅小窗开着时可见)。**穿透语义 = 位置 ‖ 2 秒时窗**(先生选定的方案 1):锁定后 `interactive = 鼠标正停在 `.dl-ctrls`(外扩 8px)上 ‖ 最近 2s 内动过鼠标`,据此 `dlIgnore(!interactive)` → 主进程 `setIgnoreMouseEvents(...,{forward:true})`(forward 让锁定态仍收得到 mousemove);静置 2s 或 `mouseleave` 回到整窗穿透。CSS 用 `html[data-locked][data-hit="1"] .dl-ctrls{opacity:.95}` 与之同步淡入淡出(`data-hit` 由 `syncIgnore()` 写)。⚠️ **返工史:第一版整窗无条件穿透 + 锁定态 `pointer-events:none` → 锁上后小窗自己的 🔒 点不到,先生判为 bug;第二版改纯位置命中(必须精确移到控制条上),先生选定时窗方案**。浏览器 popup 无穿透能力,该规则只驱动淡入淡出,**绝不禁用按钮**。状态唯一来源仍是主窗 `desktop-lyrics.js`(`locked` → `vmp.desktopLyrics.v1.locked`),协议 `{type:'lock'}`(主→小)/`{type:'toggle-lock'}`(小→主),快照带 `locked`(重开小窗自动回到锁定态;`openDesktopLyrics` 延迟 400ms 重下发)。Electron 侧:`preload.vmpShell.dlIgnore(bool)` → `ipcMain.on('dl:ignore')`;小窗实例由 `did-create-window` 捕获存 `lyricsWindow`(**IPC 可能来自主窗,不能按 e.sender 反推**;主窗绝不穿透)。**view 里 `locked` 必须先 `let` 声明**(ES 模块严格模式,赋值未声明变量直接 ReferenceError,node --check 查不出来)。测试 S32 十一项
- **界面调整 + 账号功能(2026-09-12 第二批,先生清单定调)**:①**视觉面板四组可收缩**(场景/运镜/壁纸/桌词,点标题折叠 `.fx-group-body`,状态持久化 `vmp.fxcollapsed.v1`,参数控件仍留 DOM;预设槽标题不参与折叠)②**播放条长歌名跑马灯裁切**:`.np-meta{overflow:hidden}`——旧代码没裁切,`translateX` 滑动的歌名会压到右侧「词」/「桌词」按钮上方 ③**歌单分享链接翻页取全量**:pubsongscdn H5 接口单页最多 300 首,旧代码只发 page=1 → 大歌单截断在前 300;现按 `pagesize=300` 翻到「不足一页/无新增」,hash 去重防页边界重叠,上限 20 页(6000 首),部分失败返回已取到的并标 `truncated`;`collection_3_xxx` 也可直接当歌单号粘贴(必须在数字清洗前判断)④**收藏他人歌单**:歌单搜索卡右上角 ☆(`.card-add.card-star`,常显金色)→ `collectPlaylistToKuGou()` → `/playlist/add`(cloudlist v5/add_list,type=1),未登录只提示不发请求;搜索列表需带 `gid`/创建者 `userid`(api.js `searchPlaylists` 已补映射,缺一上游拒)⑤**点 VIP 徽章进「我的酷狗」页**(view 名 `user`):UID/昵称/头像/VIP 到期 + 听歌排行 `#user-rank` + 「退出登录」「刷新」按钮;**退出登录从「两击徽章」移进该页**(`onDrawerUserClick` 已无两击逻辑),徽章副标题改「点击进入我的酷狗」;上游账号接口 502 时页面仍用本地 `vmp.login.v1` 的 UID 兜底渲染;**退出登录按钮按先生要求挪到头像栏最右侧并做成危险色常显**(原来混在「刷新」旁边太隐蔽、易误触;`.user-info{flex:1}` 把它顶到最右,`.user-logout` 用 --danger 渐变 + 辉光,`.user-actions` 只留「刷新」);**听歌排行 list_type 0(本周)为空时自动再试 1(全部)**,返回体层级与字段名跨版本不统一 → `pickRankArray()` 逐层兜底(`info`/`list`/`songs`/`data.*`)、`rankRowHtml()` 兼容 `audio_info` 嵌套。测试 S30 六项 + S31 八项

## 本机环境坑(git 推送,2026-08-27 实测)

- **全局 `~/.gitconfig` 有 GitHub URL 级代理覆盖**:`http.https://github.com.proxy = socks5://127.0.0.1:7897`(优先级高于 `http.proxy`,而 7897 未监听)→ github 操作报 `Failed to connect to github.com port 443 via 127.0.0.1 ... Could not connect to server`(实测 `git -c http.proxy= …` 覆盖不掉它,必须覆盖 URL 级键);当前可用代理在 **7890**(系统代理注册表同为 7890)。临时绕过:`git -c 'http.https://github.com.proxy=http://127.0.0.1:7890' …`;根治:`git config --global --unset http.https://github.com.proxy`
- **沙箱内 push 必须一次性放宽权限**:git 经 `sh.exe -c 'git credential-wincred get'` 调凭据助手(任何 helper 都走 sh),文件沙箱拒绝 sh 建命名管道(Win32 error 5)→ 报 `could not read Username for 'https://github.com'`;`credential.helper` 指向含空格路径会被 sh 拆断(`D:/Program: No such file or directory`),故用无空格的内置名。可直推组合:`git -c 'http.https://github.com.proxy=http://127.0.0.1:7890' -c credential.helper= -c credential.helper=wincred push` + `sandbox_permissions: danger-full-access`(wincred 读 Windows 凭据管理器,凭据由 GCM 预先存好);**`ls-remote` 不需要凭据(仓库公开)故普通沙箱即可读**
- **curl.exe 在本沙箱无法完成任何 TLS**(schannel: SEC_E_NO_CREDENTIALS 0x8009030e)→ 诊断 HTTPS 连通性别用 curl,改用 `git ls-remote` 或原始 socket CONNECT 探测(`New-Object System.Net.Sockets.TcpClient` 发 `CONNECT host:443`)

## Agent skills

### Issue tracker

Issues 存放在 GitHub issues，所有操作使用 `gh` CLI。See `docs/agents/issue-tracker.md`.

### Triage labels

默认五角色 label 词汇：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。See `docs/agents/triage-labels.md`.

### Domain docs

Single-context 布局：根目录 `CONTEXT.md` + `docs/adr/`。See `docs/agents/domain.md`.
