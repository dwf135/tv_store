package com.tvstore.app;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private long lastDownloadId = -1;
    private DownloadCompleteReceiver receiver;
    private boolean jsInterfaceAdded = false;

    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 注册下载完成广播接收器
        receiver = new DownloadCompleteReceiver();
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (android.os.Build.VERSION.SDK_INT >= 34) {
            registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            registerReceiver(receiver, filter);
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        if (!jsInterfaceAdded) {
            try {
                WebView webView = getBridge().getWebView();
                if (webView != null) {
                    webView.addJavascriptInterface(new Downloader(this), "NativeDownload");
                    jsInterfaceAdded = true;
                }
            } catch (Exception ignored) {}
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (receiver != null) {
            try {
                unregisterReceiver(receiver);
            } catch (Exception ignored) {}
        }
    }

    /**
     * 下载完成 → 自动弹出安装界面
     */
    private class DownloadCompleteReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            long downloadId = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
            if (downloadId != lastDownloadId || downloadId == -1) return;

            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) return;

            // 检查下载状态
            DownloadManager.Query query = new DownloadManager.Query();
            query.setFilterById(downloadId);
            Cursor cursor = dm.query(query);
            if (cursor == null) return;

            try {
                if (cursor.moveToFirst()) {
                    int statusIndex = cursor.getColumnIndex(DownloadManager.COLUMN_STATUS);
                    if (statusIndex < 0) return;

                    int status = cursor.getInt(statusIndex);
                    if (status == DownloadManager.STATUS_SUCCESSFUL) {
                        // 下载成功 → 弹出安装
                        installApk(context, dm, downloadId);
                    } else if (status == DownloadManager.STATUS_FAILED) {
                        showToast("下载失败，请重试");
                    }
                }
            } finally {
                cursor.close();
            }
        }
    }

    private void installApk(Context context, DownloadManager dm, long downloadId) {
        try {
            Uri uri = dm.getUriForDownloadedFile(downloadId);
            if (uri == null) {
                showToast("无法获取安装文件");
                return;
            }

            Intent install = new Intent(Intent.ACTION_VIEW);
            install.setDataAndType(uri, "application/vnd.android.package-archive");
            install.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            // Android 7.0+ 需要允许临时访问 content URI
            if (android.os.Build.VERSION.SDK_INT >= 24) {
                install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            }

            startActivity(install);
        } catch (Exception e) {
            showToast("启动安装失败，请在下载目录手动安装");
        }
    }

    private void showToast(String msg) {
        new Handler(Looper.getMainLooper()).post(() ->
            Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show()
        );
    }

    /**
     * JS 调用原生下载的接口
     */
    public class Downloader {
        private final Context ctx;

        public Downloader(Context context) {
            this.ctx = context;
        }

        @JavascriptInterface
        public void download(String url, String filename) {
            try {
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                request.setTitle(filename);
                request.setDescription("正在下载，完成后将自动弹出安装");
                request.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED
                );
                request.setDestinationInExternalPublicDir(
                    Environment.DIRECTORY_DOWNLOADS, filename
                );
                request.setAllowedOverMetered(true);
                request.setAllowedOverRoaming(true);
                request.setMimeType("application/vnd.android.package-archive");

                DownloadManager dm = (DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE);
                if (dm != null) {
                    lastDownloadId = dm.enqueue(request);
                    showToast("开始下载：" + filename);
                }
            } catch (Exception e) {
                showToast("下载启动失败：" + e.getMessage());
            }
        }
    }
}
