package com.vmp.starmusic;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 后台播放桥(Capacitor 插件,JS 侧 window.Capacitor.Plugins.BackgroundAudio)。
 *
 * start/update:把当前歌曲与播放状态交给 PlaybackService(它会拉起前台服务并刷新通知/锁屏)
 * stop:释放服务(退出播放时调用)
 * action 事件:通知栏、锁屏、耳机按钮的播放/暂停/上一首/下一首,由 JS 真正执行
 *
 * 只在安装版存在:浏览器里 window.Capacitor 为空,web/js/native-audio.js 会自动空转。
 */
@CapacitorPlugin(name = "BackgroundAudio")
public class BackgroundAudioPlugin extends Plugin {

    private static final int REQ_POST_NOTIFICATIONS = 4711;
    private boolean askedNotification = false;

    @Override
    public void load() {
        // 服务里发生的动作 → Capacitor 事件 → JS
        PlaybackService.setListener(action -> {
            JSObject data = new JSObject();
            data.put("action", action);
            notifyListeners("action", data);
        });
    }

    @PluginMethod
    public void start(PluginCall call) {
        pushInfo(call);
        call.resolve();
    }

    @PluginMethod
    public void update(PluginCall call) {
        pushInfo(call);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context ctx = getContext();
        if (ctx != null) {
            ctx.stopService(new Intent(ctx, PlaybackService.class));
        }
        PlaybackService.setListener(null);
        call.resolve();
    }

    /** 把 title/artist/playing 送进服务(服务已在跑时等价于"刷新通知") */
    private void pushInfo(PluginCall call) {
        Context ctx = getContext();
        if (ctx == null) {
            return;
        }
        Intent intent = new Intent(ctx, PlaybackService.class)
                .setAction(PlaybackService.ACTION_INFO)
                .putExtra(PlaybackService.EXTRA_TITLE, call.getString("title", "RE:KG"))
                .putExtra(PlaybackService.EXTRA_ARTIST, call.getString("artist", ""))
                .putExtra(PlaybackService.EXTRA_PLAYING,
                        Boolean.TRUE.equals(call.getBoolean("playing", Boolean.FALSE)));
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent);
            } else {
                ctx.startService(intent);
            }
        } catch (Exception ignored) {
            // 系统限制后台启动前台服务时忽略:下一次由 JS 拖动/切歌时重试
        }
        askNotificationPermissionOnce();
    }

    /** Android 13+ 通知要用户授权,否则通知栏不显示(服务本身仍运行) */
    private void askNotificationPermissionOnce() {
        if (askedNotification || Build.VERSION.SDK_INT < 33) {
            return;
        }
        Context ctx = getContext();
        if (ctx == null || getActivity() == null) {
            return;
        }
        if (ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        askedNotification = true;
        getActivity().requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS },
                REQ_POST_NOTIFICATIONS);
    }

    @Override
    protected void handleOnDestroy() {
        PlaybackService.setListener(null);
        super.handleOnDestroy();
    }
}
