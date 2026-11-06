package com.vmp.starmusic;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.system.Os;
import android.system.OsConstants;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

import java.io.File;
import java.io.FileWriter;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * RE:KG Android 壳。
 *
 * 除了注册插件与返回键,这里还有一套**屏幕内诊断**:
 * 手机上出问题时拿不到 adb,所以把关键事实直接画在界面上(可复制、可隐藏)——
 * 用户截图就能看到 SDK、ABI、**内存页大小**、WebView 加载错误码、以及任何未捕获异常。
 *
 * 2026-10 实测背景:release/debug 包装上后内置 Node 起不来且随后闪退,而 adb 在开发侧不可用。
 * 诊断要点:
 * 1) libnode.so 是插件自带的预编译二进制(ELF LOAD 段 4KB 对齐),targetSdk 36 的
 *    16KB 页设备无法加载 —— 所以先把 pageSize 打出来。
 * 2) 插件在**自己的后台线程**里启动引擎;该线程的未捕获异常会让进程直接退出,
 *    所以这里接管全局 UncaughtExceptionHandler(后台线程只记录不退出)。
 */
public class MainActivity extends BridgeActivity {

    private static final String LOG_NAME = "rekg-crash.log";
    private static final StringBuilder DIAG = new StringBuilder();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static volatile boolean crashHandlerInstalled = false;

    private TextView diagView;
    private LinearLayout diagBox;
    private Button diagToggle;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        installCrashHandler();
        long pageSize = readPageSize();
        diag("=== RE:KG " + versionName() + " 启动 ===");
        diag("sdk=" + Build.VERSION.SDK_INT
                + " abi=" + (Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "?")
                + " pageSize=" + pageSize + "(" + (pageSize == 16384 ? "16KB! 危险" : "4KB") + ")");
        diag("model=" + Build.MANUFACTURER + " " + Build.MODEL);
        writeLog("app start: sdk=" + Build.VERSION.SDK_INT + " pageSize=" + pageSize
                + " version=" + versionName(), false);

        registerPlugin(BackgroundAudioPlugin.class);
        registerPlugin(NativeShellPlugin.class);
        super.onCreate(savedInstanceState);
        installDiagOverlay();
        diag("bridge 就绪,开始加载页面");
        hookWebViewClient();
    }

    /**
     * 返回键：先问页面「有没有一层界面要关」（抽屉 / 歌词 / 弹窗 / 纯净模式 / 全屏歌词）。
     * 页面回 '0' 才走系统默认返回（Capacitor 自己的返回处理也在这条路径上，不绕过它）。
     */
    @Override
    public void onBackPressed() {
        WebView webView = getBridge() == null ? null : getBridge().getWebView();
        if (webView == null) {
            defaultBack();
            return;
        }
        webView.evaluateJavascript(
                "(window.__APP_NATIVE_BACK && window.__APP_NATIVE_BACK()) ? '1' : '0'",
                value -> {
                    if (value == null || !value.contains("1")) {
                        defaultBack();
                    }
                });
    }

    private void defaultBack() {
        super.onBackPressed();
    }

    //region 诊断面板

    private long readPageSize() {
        try {
            return Os.sysconf(OsConstants._SC_PAGESIZE);
        } catch (Throwable ignored) {
            return -1;
        }
    }

    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Throwable ignored) {
            return "?";
        }
    }

    /** 记一行诊断:写屏幕 + 写文件(文件是给 adb/文件管理取的备胎) */
    private void diag(String line) {
        String stamped = new SimpleDateFormat("HH:mm:ss", Locale.US).format(new Date()) + "  " + line + "\n";
        DIAG.append(stamped);
        Log.i("REKG", line);
        MAIN.post(this::refreshDiagView);
        writeLog(stamped, false);
    }

    private void refreshDiagView() {
        if (diagView != null) {
            diagView.setText(DIAG.toString());
        }
    }

    private int dp(int value) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics());
    }

    private void installDiagOverlay() {
        try {
            diagBox = new LinearLayout(this);
            diagBox.setOrientation(LinearLayout.VERTICAL);
            diagBox.setBackgroundColor(0xF2000000);

            ScrollView scroll = new ScrollView(this);
            diagView = new TextView(this);
            diagView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
            diagView.setTypeface(Typeface.MONOSPACE);
            diagView.setTextColor(0xFF9FE8FF);
            diagView.setPadding(dp(10), dp(10), dp(10), dp(6));
            diagView.setTextIsSelectable(true);
            scroll.addView(diagView);
            diagBox.addView(scroll, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

            LinearLayout buttons = new LinearLayout(this);
            buttons.setOrientation(LinearLayout.HORIZONTAL);

            Button copy = new Button(this);
            copy.setText("复制");
            copy.setOnClickListener(v -> {
                try {
                    ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                    if (cm != null) {
                        cm.setPrimaryClip(ClipData.newPlainText("REKG 诊断", DIAG.toString()));
                        copy.setText("已复制");
                    }
                } catch (Throwable ignored) {
                    // 复制失败也不影响看
                }
            });
            buttons.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

            Button hide = new Button(this);
            hide.setText("收起");
            hide.setOnClickListener(v -> {
                diagBox.setVisibility(View.GONE);
                if (diagToggle != null) {
                    diagToggle.setVisibility(View.VISIBLE);
                }
            });
            buttons.addView(hide, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            diagBox.addView(buttons);

            FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, dp(210), Gravity.TOP);
            addContentView(diagBox, params);

            // 收起后的恢复入口(小标签,免得看不到)
            diagToggle = new Button(this);
            diagToggle.setText("诊断");
            diagToggle.setVisibility(View.GONE);
            diagToggle.setOnClickListener(v -> {
                diagBox.setVisibility(View.VISIBLE);
                diagToggle.setVisibility(View.GONE);
            });
            FrameLayout.LayoutParams toggleParams = new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.END);
            addContentView(diagToggle, toggleParams);

            refreshDiagView();
        } catch (Throwable error) {
            Log.e("REKG", "无法创建诊断面板", error);
        }
    }

    /** 只记录,不重试:重试归属 web/error.html(server.errorPath) */
    private void hookWebViewClient() {
        try {
            if (getBridge() == null || getBridge().getWebView() == null) {
                diag("WebView 不可用(getBridge 为空)");
                return;
            }
            final WebView webView = getBridge().getWebView();
            webView.setWebViewClient(new BridgeWebViewClient(getBridge()) {
                @Override
                public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                    super.onPageStarted(view, url, favicon);
                    diag("页面开始加载: " + url);
                }

                @Override
                public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                    super.onReceivedError(view, request, error);
                    if (request != null && request.isForMainFrame()) {
                        diag("页面加载失败: " + (error == null ? "?" : error.getErrorCode() + " " + error.getDescription()));
                    }
                }

                @Override
                public void onPageFinished(WebView view, String url) {
                    super.onPageFinished(view, url);
                    diag("页面加载完成: " + url);
                }
            });
        } catch (Throwable error) {
            diag("钩 WebView 失败: " + error);
        }
    }

    //endregion

    //region 崩溃与日志落盘

    private void installCrashHandler() {
        if (crashHandlerInstalled) {
            return;
        }
        crashHandlerInstalled = true;
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        final Thread mainThread = Looper.getMainLooper().getThread();

        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            String text = "!!! 未捕获异常 thread=" + thread.getName() + "\n" + Log.getStackTraceString(error);
            DIAG.append(text).append('\n');
            Log.e("REKG", "uncaught on " + thread.getName(), error);
            writeLog(text, true);
            MAIN.post(() -> {
                refreshDiagView();
                if (diagBox != null) {
                    diagBox.setVisibility(View.VISIBLE);
                }
            });
            if (thread == mainThread && previous != null) {
                previous.uncaughtException(thread, error);
            }
        });
    }

    private void writeLog(String text, boolean alsoDownloads) {
        final String body = text.endsWith("\n") ? text : text + "\n";
        // 1) 应用外部私有目录(文件管理 → Android/data/com.vmp.starmusic/files/)
        try {
            File dir = getExternalFilesDir(null);
            if (dir != null) {
                if (!dir.exists()) {
                    dir.mkdirs();
                }
                try (FileWriter writer = new FileWriter(new File(dir, LOG_NAME), true)) {
                    writer.write(body);
                }
            }
        } catch (Throwable ignored) {
            // 没有外部存储就继续
        }
        // 2) 下载目录(API 29+ 免权限;仅在崩溃时写,避免每次启动刷一堆文件)
        if (alsoDownloads && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, LOG_NAME);
                values.put(MediaStore.Downloads.MIME_TYPE, "text/plain");
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri != null) {
                    try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                        if (out != null) {
                            out.write(body.getBytes(StandardCharsets.UTF_8));
                        }
                    }
                }
            } catch (Throwable ignored) {
                // 下载目录写不进去也不影响屏幕上的信息
            }
        }
        // 3) 应用私有目录兜底
        try (FileWriter writer = new FileWriter(new File(getFilesDir(), LOG_NAME), true)) {
            writer.write(body);
        } catch (Throwable ignored) {
            // 彻底写不了就算了
        }
    }

    //endregion
}
