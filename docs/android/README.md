# RE:KG → Android 移植

> 目标:把现有 `web/` 界面原样搬到手机,手机内自带酷狗数据能力(不依赖 PC 上的 Node 服务),
> 支持后台播放,交付可用命令行构建出 APK 的工程。

## 一、已核实的环境事实(2026-09 实测,勿凭印象)

| 项 | 事实 | 来源 |
| --- | --- | --- |
| Capacitor 版本 | `8.5.3`(core / cli / android 三者同版本) | `npm view` |
| AGP | `8.13.0` | `@capacitor/android@8.5.3` 包内 `capacitor/build.gradle` |
| compileSdk / targetSdk | `36` / `36` | 同上 |
| minSdk | `24`(Android 7.0) | 同上 |
| Java | **21**(`sourceCompatibility VERSION_21`) | 同上 |
| 本机 JDK | `C:\Program Files\Java\latest\jdk-21`(javac + keytool 齐全) | 实测 |
| 本机 Android SDK | `D:\LittleProject\VisiableMusicPlayer\tools`(cmdline-tools 22.0) | 实测 |
| 本机 Node / npm | v24.16.0 / 11.13.0 | 实测 |

**注意**:Capacitor 8 要的是 `platforms;android-36` + `build-tools;36.0.0`,不是 35。

## 二、一次性工具链准备(必须在本机终端跑)

我这边的命令沙箱有两个硬限制,决定了下面这些步骤只能由你执行:

1. **无法完成任何 TLS**(直连 / 走 7890 代理 / 腾讯镜像都失败)→ 下载 SDK、`sdkmanager` 拉包、Gradle 下依赖都不行
2. **对工作区只读**(连新建目录都被拒)→ `npm install`、`gradlew` 写 `build/` 都不行

### 2.1 补上 `cmdline-tools\latest` 这一层

sdkmanager 靠自身路径反推 SDK 根,必须是 `<sdk>\cmdline-tools\latest\bin`。

```powershell
$ct = 'D:\LittleProject\VisiableMusicPlayer\tools\cmdline-tools'
New-Item -ItemType Directory -Force "$ct\latest" | Out-Null
Move-Item "$ct\bin","$ct\lib","$ct\NOTICE.txt","$ct\source.properties" "$ct\latest\"
& "$ct\latest\bin\sdkmanager.bat" --version      # 期望输出 22.0
```

### 2.2 装 SDK 组件(约 1.5~2.5 GB)+ 接受许可

```powershell
$env:JAVA_HOME        = 'C:\Program Files\Java\latest\jdk-21'
$env:ANDROID_HOME     = 'D:\LittleProject\VisiableMusicPlayer\tools'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:PATH = "$env:ANDROID_HOME\cmdline-tools\latest\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"

sdkmanager --install "platform-tools" "platforms;android-36" "build-tools;36.0.0"
1..20 | ForEach-Object { 'y' } | sdkmanager --licenses
```

下载卡住时加代理参数重跑(本机 7890 可用):

```powershell
sdkmanager --proxy=http --proxy_host=127.0.0.1 --proxy_port=7890 --install "platform-tools" "platforms;android-36" "build-tools;36.0.0"
```

### 2.3 装 Capacitor(已写进 `package.json` 的 devDependencies)

```powershell
npm install          # 会装 @capacitor/{core,cli,android} 8.5.3
```

> Capacitor 放在 **devDependencies** 而非 dependencies:根 `package.json` 的 `dependencies` 必须保持为空
> (electron-builder 会误捆),这是项目既有铁律。

## 三、路线与阶段

### 数据层:路线 A = `capacitor-nodejs` 插件(已调研,可行)

现有功能全靠本机两个 Node 服务(`api/` :3000 + `server.js` :3001),Android 没有 Node 运行时,必须内嵌。

**选定方案**:[`capacitor-nodejs`](https://github.com/hampoelz/Capacitor-NodeJS)(底层就是 `nodejs-mobile`),
要求 Capacitor 7+(我们是 8 ✓),装 release 里的 tgz:

```powershell
npm install https://github.com/hampoelz/capacitor-nodejs/releases/download/v1.0.0-beta.9/capacitor-nodejs.tgz
npx cap sync
```

**架构(路线 A1:Node 同时提供页面与接口)**

```
APK
├─ Node 运行时(capacitor-nodejs, nodeDir = <webDir>/nodejs)
│   └─ index.js  →  起两个服务:api :3000(lite)/ server.js :3001(静态 + /api/*)
└─ WebView  →  http://localhost:3001  (server.url,与桌面开发完全同源)
```

同源带来一个关键好处:**`config.js`、CSP、CORS 一行都不用改**——
`API_BASE` 默认就是 `http://localhost:3000`,CSP 已含该源,`/api/*` 相对路径自然落在 3001。

> 备选的 A2(WebView 用 Capacitor 自带资产服务,只把接口放 3000)会让 `server.js` 变成跨源,
> 必须给它加 CORS 白名单 —— 那会动到"根 server.js 不回任何 ACAO"这条安全不变量,故不采用。

**nodejs-mobile 的已知限制,已逐条核对本仓库代码**:

| 限制 | 对本项目的影响 |
| --- | --- |
| `child_process.spawn/fork` 不可用 | 只有 `scripts/cdp_test.js`、`scripts/fps_check.js`(开发工具)用到,**服务端代码零依赖** ✓ |
| `process.cwd()` = 文件系统根 | `api/server.js:67` 用 cwd 找 `.env`,但被 `fs.existsSync` 守卫 → 找不到就跳过 ✓ |
| `process.stdin` 不可用 | 未使用 ✓ |
| `intl` 模块缺失 | `zh-CN` 排序/格式化未使用 ✓ |
| 数据目录须用 `getDataPath()` | 服务端不写盘(纯内存 + 上游请求)✓ |

**唯一需要改造的点**:根 `server.js` 用 `path.join(__dirname, 'web')` 定位静态目录,
所以在打包进 APK 的 Node 工程里,必须自带一份 `web/`(`webDir/nodejs/web/`)。
这一步用 staging 脚本生成(见下),`web/nodejs/` 加入 `.gitignore`,不进仓库也不进 Windows 安装包。

`capacitor.config.json` 里的 `server.url = http://localhost:3001` 就是为 A 准备的;
若改用 B,则删掉 `server.url`,让 Capacitor 直接托管 `web/`,再把接口换成 `http://127.0.0.1:3000`。

### 阶段与验收闸门

| 阶段 | 内容 | 闸门(不做完不进入下一阶段) |
| --- | --- | --- |
| P1a | `npx cap add android` + `gradlew assembleDebug` | 空壳 APK 能装进手机并打开 |
| P1b | `nodejs-mobile` 探针:最小 Gradle 模块启动 Node、监听 3001 | 手机里能 `GET /` 拿到 200;失败即转 B |
| P2 | 手机竖屏布局(播放条堆叠 / 抽屉近满宽 / 触控 ≥44px / 安全区) | 手机截图无横向溢出、按钮全可点 |
| P3 | 后台播放:前台服务 + MediaSession(通知栏/锁屏控制) | 息屏 3 分钟后仍在播、通知栏能暂停 |
| P4 | 悬浮桌面歌词(`SYSTEM_ALERT_WINDOW`)/ 本地音乐(SAF) | 各自单独验收 |

### 已完成的准备(P0)

- `.gitignore`:`/tools/`、`android/local.properties`、`android/.gradle/`、`android/app/build/`、`web/nodejs/`、`.npm-cache/`
- `capacitor.config.json`:appId `com.vmp.starmusic`、`webDir: web`、`server.url` 指本机 3001、开 WebView 调试
- `package.json`:Capacitor devDeps + `android:add/sync/open/build/apk` 脚本 + `mobile:shot`
- `web/js/platform.js`:识别 android/web,写 `<html data-platform>` 与 `__APP_PLATFORM`(main.js 首行 import)
- `style.css`:桌面专属控件(桌词 / 锁定)在 android 隐藏;`@media(max-width:640px)` 手机播放条三行堆叠
- `scripts/mobile_shot.mjs`:手机视口截图 + 布局体检工具
- `scripts/android-stage-node.mjs`:数据层 staging —— 把两个本地服务装配成 `web/nodejs/`(capacitor-nodejs 的 nodeDir)

**staging 体积实测**(`node scripts/android-stage-node.mjs --dry`):

| 部分 | 剪枝前 | 剪枝后 |
| --- | --- | --- |
| `api/`(含 node_modules) | 48.9 MB | **12.5 MB**(去掉 typescript 22.5 / prettier 10.7 / @types 2.1 / ts-node 等 devDeps) |
| `web/` UI | 0.9 MB | 0.9 MB |
| 合计 | 49.8 MB | **13.4 MB** |

APK 增量 ≈ 13.4MB 载荷 + Node 运行时(单 ABI 约 47MB 的 libnode,见下)≈ **60MB 上下**。

## 三·五、P1a 已跑通:构建实录(2026-09 实测)

```powershell
# 环境(每次构建都要)
$env:JAVA_HOME='C:\Program Files\Java\latest\jdk-21'
$env:ANDROID_HOME='D:\LittleProject\VisiableMusicPlayer\tools'
$env:PATH="$env:ANDROID_HOME\cmdline-tools\latest\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"

node scripts/android-stage-node.mjs     # 生成 web/nodejs/(13.4MB)
npx cap add android                     # 生成 android/ 工程(仅首次)
Set-Content android\local.properties "sdk.dir=D:\\LittleProject\\VisiableMusicPlayer\\tools" -Encoding ascii
cd android; .\gradlew.bat assembleDebug --console=plain
```

**结果**:`BUILD SUCCESSFUL in 7m 23s`(首次;含下载 Gradle 8.14.3、AGP 8.13、NDK 27、CMake 3.22.1)
产物 `android/app/build/outputs/apk/debug/app-debug.apk`,**实测 57.7MB**(arm64-v8a 单 ABI;
未加 `abiFilters` 时是 155.2MB),已复制一份到 `release/REKG-1.1.5-arm64-debug.apk` 便于安装。
包信息经 `aapt2 dump badging` 校验:`com.vmp.starmusic` / versionName 1.1.5 / minSdk 24 / targetSdk 36 / label `REKG`。

### 构建期踩到并已修的四个坑

| 坑 | 现象 | 修法 |
| --- | --- | --- |
| **Gradle 发行版下不下来** | `services.gradle.org` 直连失败 | `gradle/wrapper/gradle-wrapper.properties` 换成华为云镜像 `mirrors.huaweicloud.com/gradle/gradle-8.14.3-all.zip`(实测 260ms) |
| **明文 HTTP 被系统拦** | targetSdk 36 默认禁 cleartext,`http://localhost:3001` 会白屏 | 新增 `res/xml/network_security_config.xml` **只对 `localhost` / `127.0.0.1` 放行**,manifest 加 `android:networkSecurityConfig`(没用 `usesCleartextTraffic="true"`,那是对全网放行) |
| **启动时序竞争** | 插件在后台线程起 Node,WebView 先连 3001 → `ERR_CONNECTION_REFUSED` 且永不自动恢复 | `MainActivity` 继承 `BridgeWebViewClient`,`onReceivedError`(主框架)延时 800ms 重试、上限 12 次;`onPageFinished` 用 `pageError` 标记区分成功/错误页,否则计数被清零会无限重试 |
| **APK 155MB** | 三个 ABI 的 `libnode.so`(arm64 47.2 / v7a 43.7 / x86_64 51.7 MB)全打进去 | `app/build.gradle` 加 `ndk { abiFilters 'arm64-v8a' }`(x86_64 只服务模拟器,v7a 只服务 32 位老机) |

### 已实测验证的部分

- **内嵌 Node 启动脚本可用**:本地直接跑 `node web/nodejs/index.js` → 3000 与 3001 均 `HTTP 200`,
  日志 `[rekg] kugou api started on 127.0.0.1:3000` / `[rekg] web server started on 3001`
- **打包内容正确**:APK 内含 `assets/public/index.html`、`assets/public/nodejs/index.js`、
  `assets/public/nodejs/api/app.js`、`assets/capacitor.config.json`、`lib/arm64-v8a/libnode.so`
- **插件接入正确**:`capacitor.settings.gradle` 含 `:capacitor-nodejs`;`cap add` 时报告
  `Found 1 Capacitor plugin for android: capacitor-nodejs@1.0.0-beta.9`

### 还没验证的(需要真机)

- `adb devices` 目前为空 —— 没有设备连着,所以 **APK 尚未在手机上跑过**
- 装上去后要看的:页面是否加载出 3001(重试是否生效)、WebView 里 WebGL 是否可用、
  Node 是否真能起(Android 的 `getDataPath` 提取路径与桌面不同)

## 三·六、P3 后台播放(已实现,待真机验证)

音乐是在 WebView 的 `<audio>` 里播的,App 一退到后台,系统随时可能回收进程 —— 必须有**前台服务**把进程
提到「正在播放」优先级,否则锁屏就断。实现只用平台 API(不引入 androidx.media):

| 文件 | 职责 |
| --- | --- |
| `PlaybackService.java` | 前台服务 + 平台 `MediaSession` + `Notification.MediaStyle` 通知(上一首/播放暂停/下一首)、锁屏与蓝牙元数据 |
| `BackgroundAudioPlugin.java` | Capacitor 插件 `BackgroundAudio`:`start/update/stop` 上报歌曲与状态,`action` 事件把通知栏点击送回 JS;顺带申请 Android 13+ 的 `POST_NOTIFICATIONS` |
| `web/js/native-audio.js` | JS 侧:监听 `songchange`/`statechange` 上报;收 `action` 后真正操作 `player`(浏览器/桌面自动空转) |
| `AndroidManifest.xml` | `FOREGROUND_SERVICE` / `FOREGROUND_SERVICE_MEDIA_PLAYBACK` / `POST_NOTIFICATIONS` + `<service android:foregroundServiceType="mediaPlayback">` |

数据流:`player 事件 → native-audio.js → 插件 → 服务(刷新通知/锁屏)` 与
`通知栏按钮 → 服务 dispatch → 插件 notifyListeners → native-audio.js → player`。
**播放状态以 WebView 里的 player 为准**,原生侧只做展示与转发,避免两边状态互相打架。

**音频焦点(不是优化项,是硬要求)**:`targetSdk 36` 起,`mediaPlayback` 类型的前台服务必须持有音频焦点,
否则系统可能直接把服务叫停。所以 `PlaybackService` 在开始播放时申请 `AUDIOFOCUS_GAIN` ——
收到 `AUDIOFOCUS_LOSS`(别的 App 播歌)就暂停让位、收到 `AUDIOFOCUS_LOSS_TRANSIENT`(来电/导航)
暂停并在 `AUDIOFOCUS_GAIN` 后自动续播,销毁时释放。

**返回键**:`MainActivity.onBackPressed` 先 `evaluateJavascript` 问页面
`window.__APP_NATIVE_BACK()`,页面按 z 序逐层关闭(登录弹窗 → 纯净模式 → 歌词抽屉 → 右抽屉)并返回 `'1'`;
回 `'0'` 才走 `super.onBackPressed()`(Capacitor 自己的返回处理也在这条路径上,不绕过它)。

### 端到端验证(本地跑 APK 内那套 Node 栈,非真机)

| 验证项 | 结果 |
| --- | --- |
| UI 由内嵌 Node 提供 | `GET :3001/` → 200、7392 字节、含 `id="starfield"` |
| 手机端要加载的模块 | `/js/{platform,native-audio,main}.js` 与 `/css/style.css` 全部 200 |
| 酷狗接口 + CORS | `GET :3000/recommend/songs`(带 `Origin: http://localhost:3001`)→ 200,`ACAO=http://localhost:3001`、`ACAC=true`,返回体含 `data.song_list` / `song_list_size` |
| 白名单仍然生效 | `GET :3000/search/hot` → **404** |
| 服务启动日志 | `[rekg] kugou api started on 127.0.0.1:3000` / `[rekg] web server started on 3001` |

已核实:`PlaybackService` / `BackgroundAudioPlugin` / `MainActivity` 均编译进包;
APK 清单里 `com.vmp.starmusic.PlaybackService` 带 `foregroundServiceType=0x2`(mediaPlayback),
三条权限都在。**未验证**:真机息屏后是否持续播放、通知栏按钮是否生效(需要手机)。

## 三·七、交付相关(暗色启动 / release / 签名 / 本地音乐)

### 暗色启动(已修,白闪是真实体验问题)

模板的 `AppTheme.NoActionBar` 父主题是 `Theme.AppCompat.DayNight.NoActionBar` —— 系统浅色模式下窗口底是白的,
再叠加 Capacitor 默认白底 `splash.png`,冷启动以及「等 Node 起来」的重试期间会白闪,和暗色玻璃主题严重违和。

处置三处(都已进包并验证):

| 文件 | 内容 |
| --- | --- |
| `res/values/rekg_colors.xml` | 新增 `rekg_bg = #FF08090B`(与 `web/css/style.css` 的背景变量一致) |
| `res/drawable/rekg_splash.xml` | 纯色 layer-list 启动背景,替代白底 `splash.png` |
| `res/values/styles.xml` | `AppTheme.NoActionBar` 加 `android:windowBackground`;启动主题换成 `rekg_splash` + `windowSplashScreenBackground` |

验证:`aapt2 dump resources app-debug.apk` 能查到 `color/rekg_bg` 与 `drawable/rekg_splash`,且后者引用 `@color/rekg_bg`。

> ⚠️ XML 注释里**不能出现连续两个减号**,写 `--bg` 会让资源链接直接报错(Build failed at mergeResources)。

### release 构建与签名

```powershell
npm run android:apk        # = staging → cap copy → gradlew assembleRelease → 自动签名 + 验签
# 只想补签名(已构建过 release):
npm run android:sign
```

实测:release **56.30MB**(debug 57.97MB),签名后 `apksigner verify` 输出 `Verifies`,v2 + v3 方案。

> ⚠️ **未签名的 APK 手机装不上** —— vivo/小米都会报「应用未安装:软件包似乎无效 / 安装包缺乏开发者证书」。
> `android/app/build/outputs/apk/release/app-release-unsigned.apk` 只是中间产物,**不要发给手机**;
> `release/` 目录里现在只放能装的包(debug 用调试证书签过,release 用下面的密钥签)。

**密钥库(已生成,必须长期保留)**:`android/rekg-release.jks`,口令在 `android/rekg-release.jks.pass`,
两者都在 `.gitignore` 里。生成命令(只跑一次,存档备查):

```powershell
& "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -v -keystore android\rekg-release.jks -alias rekg `
    -keyalg RSA -keysize 2048 -validity 10000 -storepass <口令> -keypass <口令> `
    -dname "CN=REKG, O=vmp, C=CN"
```

> 🔴 **换密钥 = 以后不能覆盖安装**:Android 只允许同签名的包升级,换密钥必须先卸载,
> 登录态/歌单/壁纸会一起丢。所以 `rekg-release.jks` 请备份到别处。

### 本地音乐在 Android 上本来就可用(不需要原生插件)

`ui.js` 的 `pickFiles()` 用的是 `<input type="file" accept="audio/*,.mp3,…" multiple>` + `input.click()`;
WebView 里这会走 `WebChromeClient.onShowFileChooser`,而 Capacitor 的 `BridgeWebChromeClient` 已实现该方法
(含 `MODE_OPEN_MULTIPLE`),所以手机上点「▶ 播放本地文件」会直接拉起系统文件选择器(SAF)。
**P4 列表里的「本地音乐」因此不用写一行原生代码**,ID3 解析与本地歌单逻辑照旧复用。

## 三·八、手机登录:二维码存相册自扫(已实现)

**问题**:桌面版「扫码登录」搬到手机上直接失效 —— 同一部手机没法扫自己屏幕上的二维码。

**做法**:酷狗 App 的「扫一扫」带「相册」入口,所以只要把二维码存进系统相册,用户就能自己扫自己。

| 文件 | 职责 |
| --- | --- |
| `NativeShellPlugin.java` | Capacitor 插件 `NativeShell`.`saveImage({base64, filename})`:base64 PNG → `MediaStore` 插入相册(API 29+ 走 `RELATIVE_PATH` + `IS_PENDING`,免存储权限;API 24~28 申请 `WRITE_EXTERNAL_STORAGE`) |
| `index.html` `#qr-save` | 登录弹窗里的「保存二维码到相册」按钮,**默认 `hidden`** |
| `ui.js` | `platform === 'android'` 时才显示;拿到二维码 dataURL 后 `saveImage`;状态行提示「酷狗 App → 扫一扫 → 相册 → 选这张图」 |

桌面/浏览器里按钮始终隐藏(`hidden` + `#qr-save[hidden]{display:none}`),不影响既有登录流程与 S10 断言。
**未验证**:真机上相册是否出现该图、酷狗 App 相册入口能否识别(需要手机)。

## 三·九、应用图标(已替换模板默认图标)

原先装出来是 **Capacitor 的模板图标**。现在复用桌面图标的绘制逻辑,一条命令生成全部 Android 密度:

```powershell
node scripts/gen_icon.js --android
```

它复用同一套 SDF 手绘字形(无字体依赖),写出 5 档密度、每档三个文件:

| 文件 | 尺寸 | 用途 |
| --- | --- | --- |
| `mipmap-<density>/ic_launcher.png` | 48 / 72 / 96 / 144 / 192 | Android 7.x(API<26)的回退位图:蓝渐变圆角方 + 白色 RE |
| `mipmap-<density>/ic_launcher_round.png` | 同上 | 圆形遮罩版本 |
| `mipmap-<density>/ic_launcher_foreground.png` | 108×density(162~432) | 自适应图标的**前景层**:透明底 + 居中字标 |

自适应图标本体在 `mipmap-anydpi-v26/ic_launcher.xml`(与 `_round.xml`),背景改为新增的
`drawable/ic_launcher_bg.xml`(与位图同一套蓝渐变),前景指向上表的位图 —— 这样不同厂商的
圆形/方形/水滴形遮罩都能自适应。

**两个坑**:

1. **前景必须缩进安全区**:自适应图标画布是 108dp,安全区只有中间 72dp(0.667)。字标本体约占单位框
   0.52×0.58,所以 `FG_SCALE` 取 0.98 时字标占画布 ≈0.51×0.57 —— 实测 0.68 太小(看着像缩在角落),0.98 正好。
2. **注释里不能写 `mipmap-*/`**:`*/` 会把 JS 块注释提前闭合,直接语法报错。

**验证**:`aapt2 dump resources` 能看到 `mipmap/ic_launcher`、`ic_launcher_round`、`ic_launcher_foreground`;
把 APK 解压后各密度的 `ic_launcher.png` 与源文件做 sha256 比对 **五个全部一致**。

![REKG 图标](../..//android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png)

## 三·十、悬浮桌面歌词可行性结论(2026-10,结论:**本期不做**)

桌面版「桌词」是 `window.open` 独立置顶窗 + Electron 的 `setIgnoreMouseEvents` 穿透,Android 上要等价实现
只有一条路:`SYSTEM_ALERT_WINDOW` 悬浮窗。调研后**建议本期不做**,理由按重要性排序:

1. **权限门槛在用户侧**:`SYSTEM_ALERT_WINDOW` 是特殊权限,不能用 `requestPermissions` 弹窗申请,只能
   `Settings.canDrawOverlays()` 判断 + `Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION)` 把用户丢到系统设置页手动开。
2. **ROM 差异大且无法验证**:小米/华为/OPPO 等对悬浮窗与「后台弹出界面」有额外开关,失败表现各不相同。
   我现在**没有真机**,写了也验不了 —— 这正是这个项目一贯的红线(没验证过的功能不上线)。
3. **内容来源的选择各有一半代价**:
   - 悬浮窗里放**第二个 WebView** 加载 `http://localhost:3001/desktop-lyrics.html`:能复用现有样式与
     快照协议,但 `BroadcastChannel` 是否能在同 App 两个 WebView 间互通需要真机确认(不通就得改成插件通道),
     且多一个 WebView 的常驻内存(粗估 +30~60MB)。
   - 悬浮窗里放**原生 TextView**:内存小、可控,但歌词解析/逐行高亮/字号透明度全都得重写一遍。
4. **「锁定穿透」在 Android 上更别扭**:桌面端可以让鼠标穿透而窗口仍在;Android 要整窗 `FLAG_NOT_TOUCHABLE`,
   一旦开启用户就完全点不到,只能回主 App 解锁(我们已有等价按钮,但体验链更长)。
5. **锁屏不可见**:悬浮窗不会显示在锁屏界面之上,这是系统层的限制,和桌面「永远置顶」不是一回事。

**替代方案(已实现,见下)**:在 App 内做一个**全屏歌词页** —— 复用现有 `lyrics.js` 与 `ui.js` 的
`lyricsView`,整屏大字 + 点击切换,零原生代码、所有设备一致可用。

### 全屏歌词(已实现,替代悬浮窗)

| 位置 | 内容 |
| --- | --- |
| `index.html` | 歌词抽屉头新增 `#lyric-full-btn`(「大字」);body 级新增覆盖层 `#lyric-full`(标题 / 上一行 / 当前行 / 下一行 + 右上角 ✕) |
| `ui.js` | `renderLyricFull(t)` 直接读 `lyricsView.lines` + `findLineIndex` 渲染三行;`toggleLyricFull()` 开关并写 `window.__APP_LYRIC_FULL`;`timeupdate` 时若打开就刷新;切歌时刷新标题;Esc 与 Android 返回键都优先关它 |
| `style.css` | `.lyric-full` 覆盖层(暗色径向渐变 + 模糊,`z-index:6` 高于抽屉)、当前行 27px(手机 23px)、控件 `min-height:44px`、安全区 padding |

**为什么这条路更好**:不申请任何权限、不依赖 ROM、桌面端同样能用(想大字看歌词不必开桌词小窗),
而且全部逻辑复用已有的 `lyricsView`,新增代码不到 40 行。测试见 S37(6 项)。

## 四、手机视口截图(布局验证用)

我这边 Chrome 起不来(沙箱禁止,与本项目既有记录一致),所以这一步由你跑,把 JSON 输出贴回来 / 截图发我:

```powershell
# 1) 起 Chrome(调试端口 9333,profile 放 TEMP)
$ud = Join-Path $env:TEMP 'rekg-shot'; New-Item -ItemType Directory -Force $ud | Out-Null
Start-Process "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" -ArgumentList '--headless=new','--remote-debugging-port=9333',"--user-data-dir=$ud",'--no-first-run','--hide-scrollbars','about:blank'
# 2) 双服务(3000 + 3001)先跑起来,然后:
node scripts/mobile_shot.mjs 390 844
# 出图路径与布局数据会打印出来;桌面视口用:DESKTOP=1 node scripts/mobile_shot.mjs 1280 800
```

## 五、回归与既有产品不受影响

- Windows 安装包的 `build.files` 是白名单(`electron/**`、`server.js`、`web/**`),`android/`、`tools/`、`docs/` 都不会进包
- `web/` 的移动端改动全部落在 `@media (max-width:640px)` 与 `html[data-platform="android"]` 内,
  桌面视口行为不变;`node scripts/cdp_test.js` 仍是桌面交付标准

## 六、沙箱限制导致的"只能你跑"清单(2026-09 实测)

我这边的命令沙箱有两条硬限制,已逐条验证:

| 限制 | 验证方式 | 后果 |
| --- | --- | --- |
| **无法写工作区**(连 `New-Item` 都 `Access denied`,只有 TEMP 可写) | `Set-Content` / `New-Item` 均被拒 | `npm install`、`gradlew`、`sdkmanager`(写 `tools/`)、我写的 staging 脚本,都必须你执行 |
| **无法完成 TLS**(`Invoke-WebRequest` 直连/代理/腾讯镜像全失败) | 三次请求均报"接收时发生错误" | 下载类操作必须你执行 |
| 但 **`sdkmanager` 的 Java TLS 是通的** | `--list` 能跑到 "Fetch remote repository" | 说明只差写权限:你那边跑就能装上 |
| Chrome 起不来 | `--remote-debugging-port=9333` 连接被拒 | 手机视口截图由你跑 `node scripts/mobile_shot.mjs` |

`sdkmanager` 尝试装 android-36 时的真实报错(供对照):

```
Warning: Failed to read or create install properties file.
```

即"能联网、不能落盘",不是网络问题。所以正确的安装命令仍需你在终端执行:

```powershell
sdkmanager --install "platforms;android-36" "build-tools;36.0.0"
```
