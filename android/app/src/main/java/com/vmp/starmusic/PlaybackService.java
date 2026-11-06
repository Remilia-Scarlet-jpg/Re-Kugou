package com.vmp.starmusic;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;

/**
 * Android 后台播放服务(前台服务 + 平台 MediaSession,不引入 androidx.media 依赖)。
 *
 * 为什么需要它:音乐是在 WebView 的 <audio> 里播的,App 一退到后台,系统随时可以把进程回收 ——
 * 前台服务把进程提升到"正在播放"优先级,锁屏/息屏后音频才不会被掐断;MediaSession 负责
 * 通知栏与锁屏上的播放控制、耳机线控按键。
 *
 * 数据流:
 *   JS(player 事件) → BackgroundAudioPlugin → 本服务(intent 带 title/artist/playing)
 *   通知栏/锁屏按钮 → 本服务 dispatch() → 静态 listener → 插件 notifyListeners → JS 控制播放器
 *
 * 注意:所有控制动作都只是"请求",真正的播放状态以 WebView 里的 player 为准 ——
 * 播放器状态变化后 JS 会再回调 updateInfo,由这里刷新通知与播放状态。
 */
public class PlaybackService extends Service {

    public static final String ACTION_INFO = "com.vmp.starmusic.action.INFO";
    public static final String ACTION_TOGGLE = "com.vmp.starmusic.action.TOGGLE";
    public static final String ACTION_NEXT = "com.vmp.starmusic.action.NEXT";
    public static final String ACTION_PREV = "com.vmp.starmusic.action.PREV";

    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_ARTIST = "artist";
    public static final String EXTRA_PLAYING = "playing";

    private static final String CHANNEL_ID = "rekg_playback";
    private static final int NOTIFICATION_ID = 1001;

    /** 插件侧注册的监听:把通知栏/锁屏动作转发回 WebView */
    public interface Listener {
        void onAction(String action);
    }

    private static Listener listener;

    public static void setListener(Listener l) {
        listener = l;
    }

    private MediaSession session;
    private String title = "RE:KG";
    private String artist = "";
    private boolean playing = false;

    private AudioManager audioManager;
    private AudioManager.OnAudioFocusChangeListener focusListener;
    /** AudioFocusRequest 是 API 26+ 类型,用 Object 存一下,老系统上不会触发类加载失败 */
    private Object focusRequest;
    private boolean hasAudioFocus = false;
    private boolean pausedByFocusLoss = false;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        focusListener = change -> {
            switch (change) {
                case AudioManager.AUDIOFOCUS_LOSS:
                    // 永久丢失(别的 App 开始播音乐):暂停,不自动恢复
                    pausedByFocusLoss = false;
                    dispatch("pause");
                    break;
                case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
                case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK:
                    // 临时丢失(来电、导航播报):暂停,焦点回来后自动续播
                    pausedByFocusLoss = true;
                    dispatch("pause");
                    break;
                case AudioManager.AUDIOFOCUS_GAIN:
                    if (pausedByFocusLoss) {
                        pausedByFocusLoss = false;
                        dispatch("play");
                    }
                    break;
                default:
                    break;
            }
        };
        session = new MediaSession(this, "REKG");
        session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS
                | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        session.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() {
                dispatch("play");
            }

            @Override
            public void onPause() {
                dispatch("pause");
            }

            @Override
            public void onSkipToNext() {
                dispatch("next");
            }

            @Override
            public void onSkipToPrevious() {
                dispatch("prev");
            }
        });
        session.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String action = intent.getAction();
            if (ACTION_TOGGLE.equals(action)) {
                dispatch("toggle");
            } else if (ACTION_NEXT.equals(action)) {
                dispatch("next");
            } else if (ACTION_PREV.equals(action)) {
                dispatch("prev");
            }
            if (intent.hasExtra(EXTRA_TITLE)) {
                title = intent.getStringExtra(EXTRA_TITLE);
                artist = intent.getStringExtra(EXTRA_ARTIST);
                playing = intent.getBooleanExtra(EXTRA_PLAYING, false);
                applyInfo();
            }
        }
        startForeground(NOTIFICATION_ID, buildNotification());
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        abandonAudioFocus();
        if (session != null) {
            session.setActive(false);
            session.release();
            session = null;
        }
        listener = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ---------- 内部 ----------

    private void dispatch(String action) {
        if (listener != null) {
            listener.onAction(action);
        }
    }

    /** 把标题/歌手/播放状态同步到 MediaSession(锁屏、蓝牙、耳机都读这里) */
    private void applyInfo() {
        if (playing) {
            requestAudioFocusIfNeeded();
        }
        if (session == null) {
            return;
        }
        session.setMetadata(new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                .putLong(MediaMetadata.METADATA_KEY_DURATION, -1L)
                .build());
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY
                        | PlaybackState.ACTION_PAUSE
                        | PlaybackState.ACTION_PLAY_PAUSE
                        | PlaybackState.ACTION_SKIP_TO_NEXT
                        | PlaybackState.ACTION_SKIP_TO_PREVIOUS)
                .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                        PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1f)
                .build());
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) {
            nm.notify(NOTIFICATION_ID, buildNotification());
        }
    }

    /**
     * 申请音频焦点。两个理由:
     * 1) Android 15(targetSdk 35+)起,mediaPlayback 类型的前台服务**必须**持有音频焦点,
     *    否则系统可能直接把服务叫停 —— 我们的 targetSdk 是 36,所以这条是硬要求;
     * 2) 别的 App 开始播音乐时,我们才会收到 AUDIOFOCUS_LOSS 并主动让位。
     */
    private void requestAudioFocusIfNeeded() {
        if (hasAudioFocus || audioManager == null || focusListener == null) {
            return;
        }
        int result;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (focusRequest == null) {
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                        .setAudioAttributes(new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_MEDIA)
                                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                                .build())
                        .setOnAudioFocusChangeListener(focusListener)
                        .build();
            }
            result = audioManager.requestAudioFocus((AudioFocusRequest) focusRequest);
        } else {
            result = audioManager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC,
                    AudioManager.AUDIOFOCUS_GAIN);
        }
        hasAudioFocus = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    }

    private void abandonAudioFocus() {
        if (!hasAudioFocus || audioManager == null) {
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focusRequest != null) {
            audioManager.abandonAudioFocusRequest((AudioFocusRequest) focusRequest);
        } else if (focusListener != null) {
            audioManager.abandonAudioFocus(focusListener);
        }
        hasAudioFocus = false;
    }

    private void createChannel() {        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) {
            return;
        }
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "正在播放", NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        ch.setSound(null, null);
        nm.createNotificationChannel(ch);
    }

    private PendingIntent controlPending(String action) {
        Intent i = new Intent(this, PlaybackService.class).setAction(action);
        return PendingIntent.getService(this, action.hashCode(), i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification buildNotification() {
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        Intent open = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openPi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        b.setContentTitle(title)
                .setContentText(artist)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentIntent(openPi)
                .setOngoing(playing)                        // 播放中不可滑掉,暂停后可滑
                .setVisibility(Notification.VISIBILITY_PUBLIC) // 锁屏可见
                .setOnlyAlertOnce(true)
                .addAction(new Notification.Action.Builder(null, "上一首", controlPending(ACTION_PREV)).build())
                .addAction(new Notification.Action.Builder(null, playing ? "暂停" : "播放",
                        controlPending(ACTION_TOGGLE)).build())
                .addAction(new Notification.Action.Builder(null, "下一首", controlPending(ACTION_NEXT)).build());

        b.setStyle(new Notification.MediaStyle()
                .setMediaSession(session.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2));

        return b.build();
    }
}
