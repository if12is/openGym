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
import java.io.File;

@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

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
