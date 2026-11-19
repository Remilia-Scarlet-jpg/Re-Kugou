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
  - **版本号规则(先生定调,每次打包前照此改 package.json version)**:每次修改 +0.0.1;patch 累计满 10 次进位 minor +0.1 且 patch 归零(如 1.0.9 的下一次 → 1.1.0);**同一轮内的多次修正不重复进位**。已打包基线:1.1.1(2026-09-12 热搜移除)/ 1.1.2(2026-09-13 界面调整五项)/ **1.1.3(2026-09-17 视觉面板分组收缩 / 歌单取全量 / 收藏他人歌单 / 「我的酷狗」页 / 桌词锁定穿透 / 壁纸音量 / 音量持久化)** —— 1.1.3 安装包已产出(`release\REKG Setup 1.1.3.exe`);**当前基准 1.1.6**(先生 2026-11-06 定调:把 1.2.x 这批更新**统一归档为 1.1.6**;⚠️ 数值上低于本地已打过的 1.1.9/1.2.0/1.2.1 —— 那三个是 560MB 的异常包(见下方「打包坑」),`release/` 里可能还留着,装 1.1.6 前先卸载旧版),下次打包按规则进位为 **1.1.7**
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
  - **安装包 98MB → 560MB / win-unpacked 2.5GB(2026-11-06 定位)**:曾有带大体积构建产物的依赖写在 **`dependencies`** 里 → electron-builder 把 node_modules 整层塞进 `app.asar.unpacked`(resources 合计 2.1GB)。修法:①**根 `dependencies` 必须留空**(桌面运行时用不到的一律放 devDependencies)②`build.files` 显式排除大体积累积物 ③**排查/重打包前先删 `release/`** —— electron-builder 不会清理旧的 `win-unpacked`,残留会让你误判体积。**判断口径:`REKG Setup x.y.z.exe` 正常 98~100MB,>150MB 即中招**

## 架构地图

- 装配入口 `web/js/main.js`;`web/index.html` 的全部既有 id/class 必须保留(ui.js 绑定依赖)
- `player.js` — 单例事件总线:timeupdate/statechange/analyserready/queuechange/songchange/toast/volumechange/playmodechange;`playAt(i)`、`getQueue()` 已存在,勿重复实现;音频链 `_ensureGraph`/`_playIndex`/状态机不要动(播放模式只改 `next()` 选曲:`getPlayMode`/`setPlayMode`/`cyclePlayMode`,三态 order 顺序循环/loop-one 单曲循环/shuffle 随机播放,持久化 `vmp.playmode.v1`,标记 `window.__APP_PLAY_MODE`;**音量/静音持久化 `vmp.volume.v1`**(`_loadVolume()` 构造时恢复 + `setVolume/setMuted` 防抖 300ms 写盘 + pagehide 同步落盘,标记 `window.__APP_VOLUME`;⚠️ **ui.js 初始化只能 `updateVolumeUI()` 从 player 真值同步,勿再写 `player.setVolume(el.volume.value/100)`** —— 那会把 HTML 默认 80% 盖回去,正是先生反馈「音量不保存上一次的值」的根因);`_playLocal` 同曲重播复用同一 objectURL 不 revoke——先设新 src 再 revoke 旧,勿改回)
- `ui.js`(约 800 行)— UI 单例:el 缓存 + 渲染函数;**新增 UI 一律走 MutationObserver 沉浸模式逻辑,勿手改各渲染函数**;播放条 `#btn-mode` 三态切歌模式(顺序循环/单曲循环/随机播放,**图标是单色描边 SVG**——🔁/🔂/🔀 是彩色 emoji,Segoe UI Emoji 自带上色,CSS 压不住;`dataset.mode` 是测试标记,`textContent` 恒空;**非顺序只留 `.active` 状态标记,配色与兄弟钮同为灰**);上/下一首 `#btn-prev`/`#btn-next` 为内联 SVG「单三角+竖条」(>| 与 |<,`fill: currentColor` 跟随按钮色);**登录入口 = 抽屉用户大标题 `#drawer-user`(主页右上角登录按钮已移除):未登录→登录弹窗,已登录→VIP 徽章/「已登录」,点击进入「我的酷狗」页(不再两击退出;退出登录 = 该页内 `#user-logout` 按钮)**;「我的酷狗」`renderUserPage()`(view 名 `user`):先用本地 `vmp.login.v1` 的 UID 渲染骨架(上游账号接口 502 也必须看得到 UID),再补昵称/头像/VIP 到期与听歌排行 `#user-rank`(字段名跨版本不统一,`rankRowHtml` 逐个兜底);歌单搜索卡右上角 ☆(`.card-add.card-star`)→ `collectPlaylistToKuGou()`,未登录只提示不发请求
- `lyrics.js` — parseLRC/findLineIndex/LyricsView;**双语歌词**:酷狗外文歌的 LRC 把译文单列一行(紧跟原文、时间戳约在原句结束处)→ `pairTranslations()` 按「相邻两行语言类别不同(假名 ja / 汉字 zh / 其它 latin)+ 间隔 ≤8s」合并成 `line.trans`,译文行从时间轴移除(不占两行时间);少数歌只给 `contenttype=2` 的**无时间轴中英对照纯文本** → `parsePlainLyric()` 静态展示(`time=null`、不可 seek、不高亮,`LyricsView.static` 标记);译文渲染统一用 `.lyric-trans`(抽屉 / 全屏歌词 / 桌词小窗三处同源);歌词同步链:audio timeupdate → player emit → ui.js 处理器(注意 ui.js 只在歌词抽屉打开时才调 lyricsView.update — 桌面歌词等新消费者需绕过此闸门或另接事件);**parseLRC 过滤元信息行**(`isMetaLine`:词/曲/编曲/演唱/制作等中日署名前缀)+ `skipLine` 谓词(loadFor 传 `isTitleDupLine` 剔除「歌名 - 歌手」标题重复行,防 LRC 顶部元信息堆满歌词区)
- `visualizer3d.js` — 模块级常量 PALETTE_IDLE/PALETTE_ENERGY/E_STEPS/N_ORB=1800/N_STARS=1500/N_RING=800;相机 = user 基准轨道 + cameraman 电影偏移(已接入 fx 管线);契约同 visualizer.js:constructor/setAnalyser/setPlaying/destroy + **setSuspended(生命周期挂起 rAF,恢复时重置时钟防大步进,2D 引擎同契约)**
- `lifecycle.js` — active⇄hidden 生命周期状态机(内存优化):双信号取或(document.visibilitychange + Electron minimize/restore IPC `app:hidden`);订阅方挂起重型子系统;**桌面歌词不接入**(心跳/推送必须跨最小化存活);测试钩子 `__APP_LIFECYCLE`/`__APP_LIFECYCLE_API.hide()/show()`
- `api.js` — 酷狗接口映射(lite 数据形状兼容);`server.js` — /api/url 与 /api/playlist 两个代理;账号侧新增 `getUserDetail`(→ /user/detail · v3/get_my_info)、`getListenRank`(→ /user/listen · v2/get_list)、`collectPlaylist`(→ /playlist/add · cloudlist v5/add_list,type=1=收藏既有歌单,三要素 listid/gid/创建者 userid 缺一上游即拒),三者都走 getJsonCred 带 cookie 且带 timestamp 破缓存
- `store.js`/`config.js` — localStorage 键名 `vmp.<name>.v1` + 防抖写盘模式
- **z 序**:wallpaper-layer → canvas(底)→ 右浏览抽屉 z4 → 歌词抽屉 z5 → toast/登录弹窗;playerbar z2;跨窗口通信 = BroadcastChannel `vmp-desktop-lyrics-v1`(桌词小窗)

## 数据源关键事实(酷狗)

- **API 全局 2 分钟响应缓存**(apicache)→ 轮询类请求必须带变化的 timestamp 参数破缓存,否则永远返回首次响应
- **歌曲搜索:歌名检索优先,词曲检索兜底(2026-11-07 改版)** —— lite 模式 `/search?type=song`(v3 通道)曾在 2026-08 报 152,但 **2026-11-07 实测已恢复可用**(`total=330`),且相关性明显正确;旧的 `type=lyric`(词曲检索)按**歌词文字**排序 —— 实测搜 `the story unfolds` 时目标歌排第 5、第 1 是无关的 Window/Galdive,正是先生反馈「不按最相关排」的根因。现在 `searchSongs` = `type=song` 优先、空结果/抛错回退 `type=lyric`,再经 `rankByRelevance()` 客户端重排(全等 1000 / 前缀 820 / 包含 640 / 歌手 520 / 分词全覆盖 360 / 部分 140;同分短标题优先、再按原序)。**两条通道字段名不同,必须分开映射**:歌名通道 `OriSongName`(缺失时从 `FileName="歌手 - 歌名"` 切)/ `SingerName` / `FileHash` / `Duration`**秒** / `Image`|`AlbumImage`,**没有 `320Hash`,高码率在 `trans_param.ogg_320_hash`**;词曲通道 `SongName`/`TimeLength` 秒/`Image({size})`。⚠️ 若哪天歌名通道又回到 152,回退逻辑保证仍可用,但相关性会退回旧样
- **封面补全走 /images 接口**:分享页(dataFromSmarty)解析出的歌只有 hash + album_id 无封面 → 前端播放时按需 `GET /images?hash=&album_id=&count=1`(仅 lite 模式可用的签名接口),封面在 `data[0].album[0].sizable_cover`({size} 占位);server.js 分享/歌单号两路都保留 albumId 字段
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

- `node scripts/cdp_test.js` — Node 24 零依赖 WebSocket CDP 驱动,需双服务运行 + Chrome;当前 **336 项**(删安卓后 S36 少 1 项;⚠️ 源码里 `grep "check\('"` 只有 319 处 —— 差额来自历史累计口径,**一律以实际运行输出的分母为准**,早退分支可能少几项)。**各 S 段(S1–S43)逐条覆盖明细**已归档到 `docs/CHANGELOG-ARCHIVE.md` 的「测试段明细」;本节只留每次都要守的约定(见下几条)。
- **安装版验证**:`REKG_ALLOW_DEBUG=1` + `--remote-debugging-port=9229` 启动安装版 + `VMP_CDP_USE_EXISTING=1 node scripts/cdp_test.js`(Chrome 回归 + 安装版同 336 项双绿为交付标准;项数口径见上);**不带 REKG_ALLOW_DEBUG 时 9229 会被 strip**(CDP attach 失败先查该环境变量);attachTarget 已带重试(Electron 新 BrowserWindow 的 target 上 /json/list 有竞态,重开小窗偶发找不到)
- 测试要求**未登录态**(S10 走二维码弹窗路径);已登录态跑会因「点登录=退出确认」而失败
- .state-box 类 = 加载态与错误空态共用 → 轮询等待错误态时须排除含 .spinner 的加载态
- 操作 .nav-item/#search-input 前必须先 openDrawer()
- S9 审计豁免环境噪声(isEnvNoise):酷狗 CDN CORS/ERR_FAILED、trackercdn /api/url 504、酷狗搜索/列表上游 502/504(内容断言由各 S 段把关,审计只免日志);「存在可播行」与 S2/S3 播放进度类偶发失败属 trackercdn 上游抖动(节点下载慢 → loadedmetadata 迟迟不来),重跑即可;S2 播放条同步断言已改轮询(!paused + np 非未在播放 + 时长非 --:-- + 按钮 ⏸,15s,2026-08-14 加固,src 已设但 metadata/playing 晚到不再误报)
- **prefetch 必须传 song 对象**(`player.prefetch(song)`):`_resolveWithCache` 读 song.hash/hash320,曾误传裸 hash 导致每次切歌都发 `/api/url?hash=undefined` + 登录态 `/song/url` 无 hash 502 噪声(netwatch 堆栈定位,勿改回)
- 新功能 = 新增 S 段;跨页面状态用 `window.__APP_*` 标记暴露给测试

## 近期变更与不变量(2026-09 ~ 2026-11)

- **桌词锁定 + 鼠标穿透(2026-09-12 第三批,先生定调,含一轮返工)**:小窗控制条加 `#dl-lock`,主窗播放条加 `#dl-lock-btn`(仅小窗开着时可见)。**命中判定 = Electron 主进程轮询光标(唯一来源,勿再放回渲染进程)**:锁定后主进程每 60ms 轮询 `screen.getCursorScreenPoint()`,与 `lyricsWindow.getBounds()`(同为 DIP)比较,`可点 = 光标落在右上角控件区(顶部 DL_HOT_H=44 × 右侧 DL_HOT_W=260)`;光标离开窗口或落在歌词本体 → 立即整窗穿透。⚠️ **2026-11-17 去掉了「窗内 2 秒内动过鼠标也算可点」这条**(先生反馈「锁定后点不到桌词后面的地方」):点击必然伴随鼠标移动,那条规则让鼠标一进歌词区域就永远"可点",歌词区等于完全挡住桌面,锁定形同虚设。现在歌词本体每一寸都立即穿透,只有控件区能点。判定结果经 `webContents.send('dl:hit')` 推回小窗,只用于 🔒 的淡入淡出(`html[data-locked][data-hit="1"] #dl-lock{opacity:.95}`;**2026-11-17 起锁定时其余控件直接 display:none,不再淡化**)⚠️ **三轮返工史(勿重犯)**:①整窗无条件穿透 + 锁定态 `pointer-events:none` → 锁上后小窗自己的 🔒 点不到;②改在小窗内监听 mousemove 判位置,依赖 `setIgnoreMouseEvents(true,{forward:true})` 的转发 —— **该转发在 Windows 透明无边框窗上实测收不到**,先生装 1.1.3 后反馈「锁上后只能开主界面才能解锁」;③现版完全由主进程轮询判定,**不依赖任何事件转发**。浏览器 popup 无穿透能力,`data-hit` 恒为 1(控件常显常可点),**绝不禁用按钮**。状态唯一来源仍是主窗 `desktop-lyrics.js`(`locked` → `vmp.desktopLyrics.v1.locked`),协议 `{type:'lock'}`(主→小)/`{type:'toggle-lock'}`(小→主),快照带 `locked`(重开小窗自动回到锁定态;`openDesktopLyrics` 延迟 400ms 重下发)。Electron 侧:`preload.vmpShell.dlLock(bool)` → `ipcMain.on('dl:lock')` 启停轮询、`onDlHit(cb)` 收 `dl:hit`;小窗实例由 `did-create-window` 捕获存 `lyricsWindow`(**IPC 可能来自主窗,不能按 e.sender 反推**;主窗绝不穿透)。**view 里 `locked` 必须先 `let` 声明**(ES 模块严格模式,赋值未声明变量直接 ReferenceError,node --check 查不出来)。测试 S32 十一项
- **桌词瘦身 + 当前句放大(2026-11-17 先生要求,截图定调)**:小窗只展示**当前句 / 译文 / 下一句**三行。①删掉顶栏 `#dl-title`(歌名)与页脚 `#dl-meta`(「歌名 - 歌手」)—— HTML 元素、view.js 的 `el.title`/`el.meta` 引用与两处 `textContent` 赋值、CSS 对应规则全清;`.dl-ctrls` 加 `margin-left:auto` 靠右,`.dl-current` 加 `margin-top:auto` + `.dl-next` 加 `margin-bottom:auto` 让三行整块垂直居中(旧的 `margin-top:auto` 在 `.dl-meta` 上,删了必须转移,否则歌词贴顶)②`--dl-cur-size: 20px → 24px`(放大 0.2 倍);**译文 16px 与下一句不跟着放大**(先生只要求当前句)③锁定态:`html[data-locked="1"] .dl-ctrls > :not(#dl-lock){display:none}` —— A−/A+/音量/✕ **隐藏且不可点**,只留 🔒;旧规则是整条控件栏 opacity .28 淡化(仍可点),已废;解锁后自动恢复。⚠️ **选择器必须带 `="1"`**:view.js 解锁是 `dataset.locked = '0'`(不是删属性),而 `html[data-locked]` 是「属性存在即匹配」→ 写成单属性选择器解锁后控件永远回不来(先生 2026-11-17 实测「解锁了功能呢」即此 bug;旧版 opacity 淡化同样一直生效,只是不明显)。S32 的「解锁:其余控件恢复显示」就是钉这条。⚠️ S23 两条字号断言因此改 `24px`。测试 S32 十一项
- **纯净模式 + 左上角 logo 移除(2026-09-17 先生要求)**:①`#float-logo`(左上角 RE:KG 悬浮按钮)整体删除 —— `index.html` 元素、ui.js `el.floatLogo` 缓存与 click 绑定、`style.css` 三条 `.float-logo` 规则全清,**抽屉入口只剩右侧边缘标签 `#drawer-tab`**(S11「logo 重开抽屉」断言同步改用该 id)。②播放条最右端(音量数字之后)新增「隐藏」`#ui-hide-btn` → `body.ui-hidden` 收起播放栏 / 右抽屉 / 边缘标签 / Electron 标题栏(`#win-bar`,安装版连窗口拖拽一并收起),只留壁纸与粒子(**歌词抽屉自 2026-11-16 起不在隐藏清单:已打开的歌词页保留显示**);恢复靠**右下角 `#ui-show-btn`**(平时 `opacity:0` + `pointer-events:none`,只在纯净模式下淡入,悬停增亮)与 **Esc**(keydown 中优先于「Esc 关抽屉」)。⚠️ **恢复入口必须常驻可达**,少了它用户就被关在门外;`window.__APP_UI_HIDDEN` 是测试标记。测试 S35 九项
- **歌词抽屉头部窄面板适配(2026-11-16 先生要求,截图定调)**:窗口非最大化时抽屉一窄,头部的标题与「译 / 大字 / ✕」就互相压住、点不准。修法三条——①`.lyric-head-left` 改 `flex: 1 1 auto`(原本没有 flex,按内容撑开挤掉按钮)、`#lyric-title` 补 `flex:1 1 auto; min-width:0`(省略号才生效)、`.lyric-head > .chip` 固定 `flex: 0 0 auto`,**按钮永不被压扁** ②「大字」按钮内容拆成 `.lbl-wide`(大字)/`.lbl-narrow`(大)两段,`.lyric-drawer` 上加 `container-type: inline-size`,再用 `@container (max-width: 330px)` 只在**面板自身**窄到 330px 以下时切成单字 —— 用容器查询而非媒体查询,是因为后续「面板可拖拽改宽」时窗口未必变窄,`@media` 抓不到面板宽度 ③`.lyric-drawer` 是 `position:fixed` 且内部无 fixed 后代,加 `container-type` 不改变定位行为(若将来在抽屉里放 fixed 元素要重新评估)。测试 S35 九项
- **面板左右拉伸(2026-11-16 先生要求)**:歌词页与右侧抽屉都能拖**左边缘**改宽度,拖拽时内容实时回流。要点:①宽度走 CSS 变量 `--panel-w`(`.lyric-drawer` / `.right-drawer` 的 `width` 都改成 `min(var(--panel-w, 默认值), …)`),**逐 move 写变量** = 实时回流,不用等松手 ②上限 = 各自默认宽(歌词 380 / 抽屉 420,**左边界不能再往左**),下限 = 默认的一半(190 / 210),`panelClamp()` 统一钳制 ③热区是 `::before` 伪元素 7px、`cursor: col-resize`,**不新增 DOM**(不碰既有 id/class 绑定);面板关闭时整体 translateX 出屏,热区自然点不到 ④`pointerdown` 判定只看 `e.clientX - rect.left <= 7`,`pointermove`/`pointerup` 挂 **window**(指针移出面板也不断,**不用 pointer capture** —— 合成事件同样能驱动,CDP 可测)⑤落盘 `vmp.panelWidths.v1 = {lyric, drawer}`,`initPanelResize()` 在 init 里恢复;拖拽期间加 `.resizing`(去过渡)与 `body.panel-resizing`(锁全局 col-resize + 禁选中)⑥窄屏 `@media(max-width:900px)` 的歌词抽屉宽度也改成 `min(var(--panel-w,380px), calc(100vw - 24px))`,否则窄屏拖拽失效。测试标记 `__APP_PANEL_LYRIC` / `__APP_PANEL_DRAWER`。测试 S43 三项
- **双语歌词 + 桌词字号语义(2026-11-05 先生要求,截图定调)**:①**外文歌译文挂在原句下**(对齐酷狗 PC 播放器)。实测结论:`/lyric?fmt=lrc` 对双语歌返回的就是「原文行 + 紧随其后的译文行」,**两行时间戳不同**(译文 ≈ 原句结束时刻,如 `[00:12.86]There ain't no gold` / `[00:15.69]并没有宝藏`),**不是同时间戳双行** —— 所以配对只能按「相邻两行语言类别不同 + 间隔 ≤8s」(kana→ja / CJK→zh / 其余→latin),`pairTranslations()` 在 parseLRC 返回前完成,译文行从时间轴移除;另有少数歌只给 `contenttype=2` 的**无时间轴中英对照纯文本**(`/lyric` 响应里 `contenttype` 字段可查)→ `parsePlainLyric()` 静态展示,避免此前直接「暂无歌词」。译文统一 `.lyric-trans` 类:抽屉(12px)/ 全屏歌词(16px)/ 桌词小窗(**固定 16px 小字**,不跟当前句放大 —— 先生 2026-11-06 明确「底下要的是中文小字翻译,不是大字」;2026-11-19 反馈太小,13 → 16)三处同源。②**桌词字号语义改为「当前句固定、滑杆只调下一句」**:`.dl-current` 改吃固定变量 `--dl-cur-size: 24px`(不再随 `dlFontSize` 变;40 → 30 → 20,2026-11-17 再放大 0.2 倍到 24),滑杆 `dlFontSize`(24..64)只通过 `.dl-next` 的 `0.42 倍` 生效;`#dl-trans` 是 `#dl-current` 的**兄弟节点**(不是子节点)—— 这样 `#dl-current` 仍是纯原句文本(S23 的 `textContent` 断言不受影响),也避免 `-webkit-line-clamp` 把译文一起截断。⚠️ S23 两条字号断言因此改为「`#dl-current` 恒 24px + `#dl-next` ≈ 字号×0.42(带 0.5 容差)」。测试 S38 四项
- **AI 歌词翻译(2026-11-06 先生要求)**:实测确认**酷狗歌词接口对外文歌不保证带译文**(例:「For Your Pieces feat. 三澤秋」的 LRC 31 行全是日文,candidate 里 `transuid=0`/`transname=''`/`language=日语`,KRC 原始内容里也没有中文块)——而酷狗 PC 端能显示中文,说明那资源不走这个接口。于是改为**自建翻译链路**:①根 `server.js` 新增**唯一非 GET 路由** `POST /api/translate`:`readJsonBody`(256KB 上限)→ 拼 system prompt(`先在内部通读全篇把握主题/情绪/叙事,再逐行翻译,行数必须一致,只输出 JSON 字符串数组`)→ 调任意 **OpenAI 兼容** `/chat/completions` → `parseTranslations()` 容忍 ```json 围栏/数组外废话/逐行纯文本三种输出 → 回 `{ok, translations}`;`REKG_LLM_KEY` 未配置时回 `{ok:false,reason:'nokey'}`(HTTP 200,前端只提示不报错),`REKG_LLM_MOCK=1` 回「第N行译文」用于离线验链路。**key 只在本进程**,页面拿不到(这是放服务端而非页面的根本原因;同源也免了 CORS)。②`web/js/translate.js`:`vmp.lyricTrans.v1 = {on, cache:{<hash>:[...]}}`,开关与译文都落 localStorage,按曲目 hash 缓存(最多 40 首,超了丢最旧),`needsTranslation()` 判据 = 有外文行且中文行占比 <75%(中文歌不发请求,省钱且避免中文翻中文)。③`LyricsView._maybeTranslate()` 在 `_renderLines()` 之后**异步补译**(先出原文不卡首屏),失败静默;`retranslate()/clearTrans()` 供「译」按钮切换(只清 AI 加的 `aiTrans`,接口自带译文保留)。④UI:歌词抽屉头「译」`#lyric-trans-btn`,开启态点亮。**已验**:mock 返回正确/无 key 回 nokey/GET 405/坏 body 400;**并用本机 DSH 那把 key 端到端跑通真实调用**(`Hello world` → 「你好，世界」)。⑤**密钥取得方式有三条**(2026-11-06 补齐,因为代理环境写不了注册表):系统环境变量 `REKG_LLM_KEY` → 密钥文件 `%APPDATA%\REKG\llm-key.txt`(server.js `readKeyFile()`,1.2.1 起)→ 启动器 `scripts/launch-rekg-with-key.mjs`(启动时把 key 注入子进程 env,不写系统设置,改编自同一把 DSH 凭据)。配套脚本 `scripts/set-llm-key.mjs`(setx 失败自动改写密钥文件)、`scripts/check-llm-key.mjs`(只读诊断)。⑥**客户端内设置密钥(1.2.1,先生要求「初始不带密钥、没密钥点翻译要弹出设置位置」)**:新增 `GET/POST /api/llm-key` —— GET 只回 `{configured, masked, source, file}`(**绝不回明文**);POST 三用:`{key:'sk-…'}` 保存、`{key:''}` 清除(来自环境变量时回 `envLocked:true` 且删不掉)、`{action:'persist'}` 把当前用的密钥落成密钥文件。**必须是 `Content-Type: application/json`**,否则 415 —— 跨站 `<form>` 设不了这个头、`fetch` 会触发 CORS 预检而本服务不回 ACAO,等于 CSRF 防护。保存后**改的是内存变量 `llmKey`**(不是重启才读),立刻生效。前端 `#llm-modal`(复用 `.login-modal/.login-box` 外壳 + `.llm-input`):点「译」先 `getKeyStatus()`,**未配置就弹设置窗而不是打开开关**;保存成功自动开开关并 `retranslate()`;`#llm-persist` 按钮仅在 source==='env' 时出现;用户页「我的酷狗」加 `#user-llm` 入口(事件委托,页面重渲染也不丢);Esc 可关(`__APP_LLM_MODAL`/`__APP_LLM_KEY` 是测试标记)。⑦**「有时候点了译也不翻」的根因与修法(2026-11-07 先生反馈,用真实韩文歌词复现)**:两个 bug 叠加 —— ①`pairTranslations` 早期只要「相邻两行语言类别不同」就配对,酷狗的**英文署名行**因此被当成译文(实测 FAKE LOVE:`[0] FAKE LOVE - BTS (防弹少年团)` ⇒ `Produced by：Pdogg`;비와 당신 ⇒ `Piano by：Hen`)②`_maybeTranslate` 的跳过条件是 `lines.some(l => l.trans)` —— **有任意一行译文就整首不翻**。于是「一行垃圾译文 = 整首没译文」。修法:配对**只认中文行当译文**(`curCls !== 'zh' && nxtCls === 'zh'`),署名行(`META_LINE_RE` 扩到英文 `Xxx by:` 写法 + `looksLikeCredit()`)既不参与配对也不进歌词区;跳过改为**覆盖率**(≥60% 行已有译文才认为接口自带双语),否则整首翻且**只补空缺行**(不覆盖已有);失败不再静默 —— `_transFail()` 按 reason 给中文提示(toast 同因去重),`transError` 让「译」按钮转琥珀色(`#lyric-trans-btn.err`)且点一下变成重试。实测 4 首韩文歌(에픽하이/아이유/BTS/이무진)修复前 3 首被跳过,修复后全部 `some(trans)=false` 正常触发。测试 S41 三项
- 2026-08 ~ 2026-09 的历史交付记录已归档到 [docs/CHANGELOG-ARCHIVE.md](docs/CHANGELOG-ARCHIVE.md)(25 条),此处只保留仍在迭代的近两周条目。

## 本机环境坑(git 推送,2026-08-27 实测)

- **PowerShell 5.1 会把「无 BOM 的 UTF-8 .ps1」当 GBK 读**(2026-11-06 实测):中文注释直接乱码并 parse error(`Unexpected token '鍦?$cred'`)——**本机 PATH 里没有 `pwsh`**(只有 `powershell.exe` 5.1)。处置:项目里的 `.ps1` 只做**纯 ASCII 转发壳**(`node "$PSScriptRoot\xxx.mjs"`),真正逻辑写在 `.mjs`(Node 原生 UTF-8);`.cmd` 同样保持 ASCII(与 start.bat 铁律同源)。另外**代理沙箱没有写 HKCU 的权限**(`SetEnvironmentVariable(...,'User')` → `Requested registry access is not allowed`),所以「设置用户环境变量」这类操作只能由用户在他的终端执行,代理只能给脚本。
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
