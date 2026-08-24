package ch.duartesantos.opengym

import android.app.Activity
import android.os.Bundle
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * The screen behind "Privacy policy" on the Health Connect consent sheet.
 *
 * Health Connect will not let an app ask for health permissions without one, and
 * on Android 14+ the permission picker can come up empty if the activity is
 * missing — so this is a requirement of the feature working at all, not a
 * compliance chore to do at the end.
 *
 * The page is the copy that ships in the web bundle (public/privacy-health.html →
 * assets/public after `cap sync`), so it is available with no network and reads
 * in the same language and theme as the rest of the app.
 */
class HealthRationaleActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val web = WebView(this)
        web.settings.javaScriptEnabled = false
        // Everything the page needs is inline. Refusing navigation keeps a
        // permission-flow screen from becoming a browser.
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean = true
        }
        web.loadUrl("file:///android_asset/public/privacy-health.html")
        setContentView(web)
    }
}
