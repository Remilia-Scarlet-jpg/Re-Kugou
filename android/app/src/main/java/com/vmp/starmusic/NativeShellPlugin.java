package com.vmp.starmusic;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.OutputStream;

/**
 * 手机壳能力(与播放无关):把页面上的图片存进系统相册。
 *
 * 为什么需要:同一部手机没法扫自己屏幕上的二维码 —— 桌面版「扫码登录」搬到手机上直接失效。
 * 酷狗 App 的「扫一扫」带「相册」入口,所以只要把二维码存进相册,用户就能自己扫自己,
 * 不必再依赖第二台设备。
 *
 * 权限:
 *  - API 29+(Q)起走 MediaStore + RELATIVE_PATH,应用自己插入的图片**不需要**存储权限;
 *  - API 24~28 需要 WRITE_EXTERNAL_STORAGE(manifest 里用 maxSdkVersion=28 限定),
 *    首次保存时向用户申请,拿到后再点一次即可。
 */
@CapacitorPlugin(name = "NativeShell")
public class NativeShellPlugin extends Plugin {

    private static final int REQ_WRITE_STORAGE = 4712;

    @PluginMethod
    public void saveImage(PluginCall call) {
        String base64 = call.getString("base64");
        String name = call.getString("filename", "rekg-" + System.currentTimeMillis() + ".png");
        if (base64 == null || base64.isEmpty()) {
            call.reject("缺少图片数据");
            return;
        }
        Context ctx = getContext();
        if (ctx == null) {
            call.reject("上下文不可用");
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                && ctx.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            if (getActivity() != null) {
                getActivity().requestPermissions(
                        new String[] { Manifest.permission.WRITE_EXTERNAL_STORAGE }, REQ_WRITE_STORAGE);
            }
            call.reject("需要存储权限,请允许后再点一次");
            return;
        }

        Uri uri = null;
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (bitmap == null) {
                call.reject("图片解码失败");
                return;
            }

            ContentValues values = new ContentValues();
            values.put(MediaStore.Images.Media.DISPLAY_NAME, name);
            values.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                values.put(MediaStore.Images.Media.RELATIVE_PATH,
                        Environment.DIRECTORY_PICTURES + "/REKG");
                values.put(MediaStore.Images.Media.IS_PENDING, 1);
            }

            ContentResolver resolver = ctx.getContentResolver();
            uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (uri == null) {
                call.reject("无法写入相册");
                return;
            }
            try (OutputStream out = resolver.openOutputStream(uri)) {
                if (out == null) {
                    call.reject("无法写入相册");
                    return;
                }
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues done = new ContentValues();
                done.put(MediaStore.Images.Media.IS_PENDING, 0);
                resolver.update(uri, done, null, null);
            }

            JSObject ret = new JSObject();
            ret.put("uri", uri.toString());
            call.resolve(ret);
        } catch (Exception e) {
            if (uri != null) {
                try {
                    ctx.getContentResolver().delete(uri, null, null);
                } catch (Exception ignored) {
                    // 清理失败不影响主流程
                }
            }
            call.reject("保存失败:" + (e.getMessage() == null ? "未知错误" : e.getMessage()));
        }
    }
}
