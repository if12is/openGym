package ch.duartesantos.opengym;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

    // Networking happens here rather than in the WebView, and that is the whole
    // point of these two methods.
    //
    // The update manifest and the APK both live on GitHub release assets, which
    // 302 to a storage host and send no Access-Control-Allow-Origin on either
    // hop. A fetch() from the WebView's https://localhost origin is therefore a
    // cross-origin request the browser will not complete — and in this WebView it
    // hangs rather than rejecting, which is why the update card sat on
    // "Checking…" forever with nothing to retry and no error to show.
    //
    // HttpURLConnection has no same-origin policy to answer to, and takes real
    // timeouts, so it either returns or fails in bounded time.
    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 30000;

    private final ExecutorService io = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void getAppVersion(PluginCall call) {
        try {
            PackageInfo info = getContext().getPackageManager()
                .getPackageInfo(getContext().getPackageName(), 0);
            JSObject ret = new JSObject();
            long code = Build.VERSION.SDK_INT >= 28
                ? info.getLongVersionCode()
                : info.versionCode;
            ret.put("versionCode", code);
            ret.put("versionName", info.versionName);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }

    /** Fetch a small text body (the update manifest). Redirects followed manually
     *  so an https -> https hop to the storage host keeps working. */
    @PluginMethod
    public void httpGet(PluginCall call) {
        final String url = call.getString("url");
        if (url == null) { call.reject("url required"); return; }
        io.execute(() -> {
            HttpURLConnection conn = null;
            try {
                conn = open(url, null);
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) { call.reject("HTTP " + code); return; }
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                try (InputStream in = conn.getInputStream()) {
                    byte[] buf = new byte[8192];
                    int n;
                    // A manifest is a few hundred bytes; anything this size is a
                    // wrong URL, and buffering it into memory would be the bug.
                    while ((n = in.read(buf)) > 0 && out.size() < 1_000_000) out.write(buf, 0, n);
                }
                JSObject ret = new JSObject();
                ret.put("status", code);
                ret.put("body", out.toString("UTF-8"));
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "network" : e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    /**
     * Download to a file, appending from `offset` so an interrupted download
     * resumes instead of starting over. Progress is reported back as plugin
     * events rather than a return value, because the APK is ~10 MB and a single
     * resolve at the end would leave the bar frozen the whole time.
     */
    @PluginMethod
    public void downloadFile(PluginCall call) {
        final String url = call.getString("url");
        final String dest = call.getString("path");
        final long offset = call.getLong("offset", 0L);
        if (url == null || dest == null) { call.reject("url and path required"); return; }
        io.execute(() -> {
            HttpURLConnection conn = null;
            try {
                File file = new File(dest);
                File parent = file.getParentFile();
                if (parent != null) parent.mkdirs();

                conn = open(url, offset > 0 ? "bytes=" + offset + "-" : null);
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) { call.reject("HTTP " + code); return; }
                // 206 means the server honoured the range; a 200 to a ranged
                // request means it ignored it and is sending the whole file, so
                // the partial on disk has to go or the two would be concatenated.
                boolean append = offset > 0 && code == 206;
                long already = append ? offset : 0;
                long total = already + Math.max(0, conn.getContentLengthLong());

                try (InputStream in = conn.getInputStream();
                     OutputStream fos = new FileOutputStream(file, append)) {
                    byte[] buf = new byte[64 * 1024];
                    long got = already;
                    long lastNotify = 0;
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        fos.write(buf, 0, n);
                        got += n;
                        // Throttled: a JS bridge message per 64 KB chunk would be
                        // ~160 messages for a 10 MB file competing with the UI.
                        if (got - lastNotify > 256 * 1024) {
                            lastNotify = got;
                            JSObject ev = new JSObject();
                            ev.put("loaded", got);
                            ev.put("total", total);
                            notifyListeners("downloadProgress", ev);
                        }
                    }
                    JSObject ret = new JSObject();
                    ret.put("bytes", got);
                    ret.put("total", total);
                    call.resolve(ret);
                }
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "network" : e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    /** Follows redirects by hand: HttpURLConnection drops the Range header on an
     *  automatic redirect, which would silently restart a resumed download. */
    private HttpURLConnection open(String url, String range) throws Exception {
        String current = url;
        for (int hop = 0; hop < 5; hop++) {
            HttpURLConnection conn = (HttpURLConnection) new URL(current).openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setRequestProperty("Accept", "*/*");
            if (range != null) conn.setRequestProperty("Range", range);
            int code = conn.getResponseCode();
            if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                String next = conn.getHeaderField("Location");
                conn.disconnect();
                if (next == null) throw new Exception("redirect without location");
                current = new URL(new URL(current), next).toString();
                continue;
            }
            return conn;
        }
        throw new Exception("too many redirects");
    }

    @PluginMethod
    public void installApk(PluginCall call) {
        String uriStr = call.getString("uri");
        if (uriStr == null) {
            call.reject("uri required");
            return;
        }
        try {
            Uri uri;
            if (uriStr.startsWith("content://")) {
                uri = Uri.parse(uriStr);
            } else {
                String path = uriStr.startsWith("file://") ? uriStr.substring(7) : uriStr;
                File file = new File(path);
                uri = FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    file
                );
            }
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage(), e);
        }
    }
}
