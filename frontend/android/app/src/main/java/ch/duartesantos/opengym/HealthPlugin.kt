package ch.duartesantos.opengym

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.activity.result.ActivityResult
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.metadata.DataOrigin
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import java.time.Instant
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * Health bridge — read only.
 *
 * Health Connect is the default, including on Honor/Huawei: that is where
 * Health Sync writes, and those phones need the Health Connect permission
 * screen rather than a silent in-app picker. Huawei Health Kit is used only
 * when AppGallery Connect is actually wired into the APK.
 *
 * The JS contract is the same either way (lib/health-connect.js): epoch
 * milliseconds, empty lists when nothing is recorded, stable reject codes.
 *
 * Health Connect's client bind can hang on Honor/Huawei. Binding is timed,
 * never done on the UI thread, and never required just to open the Health
 * Connect permission screen.
 */
@CapacitorPlugin(name = "Health")
class HealthPlugin : Plugin() {

    // IO, not Main: HealthConnectClient.getOrCreate() binds to a provider service
    // and on Honor/Huawei that bind can sit forever. Doing it on the UI thread
    // (or blocking the Capacitor handler until it returns) is why the connect
    // sheet used to freeze on "Waiting for Health Connect…" with no permission
    // picker — JS never got a resolve/reject.
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // A page bigger than this is refused by the platform. Heart rate over a full
    // day comfortably exceeds one page, so every read below follows pageToken.
    private val pageSize = 1000

    // Health Sync is the watch→Health Connect bridge the setup screen asks for.
    // Honor Health and the phone also write; summing every origin double-counts
    // the same walk. Aggregate() would dedupe, but it hangs on these phones.
    private val watchWriters = listOf(
        "nl.appyhapps.healthsync",
        "com.hihonor.health",
        "com.huawei.health",
    )
    private val phoneWriters = setOf("com.android.healthconnect.phone", "android")

    // Honor/Huawei: getOrCreate can hang even when getSdkStatus says AVAILABLE,
    // because Health Sync's store is present but the Google client bind isn't.
    // kotlinx withTimeout cannot abort a blocking bind, so this uses Future.get.
    private fun <T> runTimed(ms: Long, block: () -> T): T? {
        val exec = Executors.newSingleThreadExecutor()
        return try {
            exec.submit(Callable { block() }).get(ms, TimeUnit.MILLISECONDS)
        } catch (e: Throwable) {
            null
        } finally {
            exec.shutdownNow()
        }
    }

    // Same hard deadline, but the cause is preserved. runTimed swallows
    // SecurityException into null, which would turn "not allowed" into a timeout
    // on a read — the one thing the pull log then cannot explain.
    private fun <T> runQuery(ms: Long, block: () -> T): T {
        val exec = Executors.newSingleThreadExecutor()
        try {
            return exec.submit(Callable { block() }).get(ms, TimeUnit.MILLISECONDS)
        } catch (e: TimeoutException) {
            throw RuntimeException("timeout")
        } catch (e: ExecutionException) {
            val cause = e.cause
            if (cause is SecurityException) throw cause
            throw (cause ?: e)
        } catch (e: InterruptedException) {
            throw RuntimeException("timeout")
        } finally {
            exec.shutdownNow()
        }
    }

    @Volatile private var hcClient: HealthConnectClient? = null

    private fun clientOrNull(): HealthConnectClient? {
        hcClient?.let { return it }
        val c = runTimed(8_000) { HealthConnectClient.getOrCreate(context) } ?: return null
        hcClient = c
        return c
    }

    /** JS scope names → Health Connect permission strings. */
    private fun permissionFor(scope: String): String? = when (scope) {
        "READ_HEART_RATE" -> HealthPermission.getReadPermission(HeartRateRecord::class)
        "READ_RESTING_HEART_RATE" -> HealthPermission.getReadPermission(RestingHeartRateRecord::class)
        "READ_SLEEP" -> HealthPermission.getReadPermission(SleepSessionRecord::class)
        "READ_STEPS" -> HealthPermission.getReadPermission(StepsRecord::class)
        "READ_ACTIVE_CALORIES_BURNED" -> HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class)
        "READ_TOTAL_CALORIES_BURNED" -> HealthPermission.getReadPermission(TotalCaloriesBurnedRecord::class)
        "READ_EXERCISE" -> HealthPermission.getReadPermission(ExerciseSessionRecord::class)
        "READ_OXYGEN_SATURATION" -> HealthPermission.getReadPermission(OxygenSaturationRecord::class)
        "READ_HEART_RATE_VARIABILITY" -> HealthPermission.getReadPermission(HeartRateVariabilityRmssdRecord::class)
        else -> null
    }

    private fun scopeNames(): List<String> = listOf(
        "READ_HEART_RATE", "READ_RESTING_HEART_RATE", "READ_SLEEP", "READ_STEPS",
        "READ_ACTIVE_CALORIES_BURNED", "READ_TOTAL_CALORIES_BURNED", "READ_EXERCISE",
        "READ_OXYGEN_SATURATION", "READ_HEART_RATE_VARIABILITY"
    )

    private fun requestedScopes(call: PluginCall): List<String> {
        val arr = call.getArray("read") ?: return emptyList()
        return (0 until arr.length()).mapNotNull { runCatching { arr.getString(it) }.getOrNull() }
    }

    private fun originsOf(call: PluginCall): Set<DataOrigin> {
        val arr = call.getArray("origins") ?: return emptySet()
        return (0 until arr.length())
            .mapNotNull { runCatching { arr.getString(it) }.getOrNull() }
            .map { DataOrigin(it) }
            .toSet()
    }

    private fun range(call: PluginCall): TimeRangeFilter? {
        val start = call.getLong("start") ?: return null
        val end = call.getLong("end") ?: return null
        if (end <= start) return null
        return TimeRangeFilter.between(Instant.ofEpochMilli(start), Instant.ofEpochMilli(end))
    }

    /**
     * Every read funnels through here so paging and error mapping happen once.
     *
     * Uses the reified `ReadRecordsRequest<T>(…)` factory rather than the
     * `recordType = …` constructor: that one is annotated @RestrictTo(LIBRARY)
     * and @ExperimentalDeduplicationApi, so it is not part of the public surface
     * even though it is the signature most examples show.
     */
    private suspend inline fun <reified T : Record> readAll(
        filter: TimeRangeFilter,
        origins: Set<DataOrigin>
    ): List<T> {
        val c = clientOrNull() ?: throw RuntimeException("no-bind")
        val out = mutableListOf<T>()
        var token: String? = null
        do {
            val res = c.readRecords(
                ReadRecordsRequest<T>(
                    timeRangeFilter = filter,
                    dataOriginFilter = origins,
                    ascendingOrder = true,
                    pageSize = pageSize,
                    pageToken = token
                )
            )
            out.addAll(res.records)
            token = res.pageToken
            // A window wide enough to page forever is a caller bug (asking for a
            // year of heart rate). Stop rather than hang the WebView on it.
            if (out.size > 60_000) break
        } while (token != null)
        return out
    }

    private fun preferredPackages(available: Collection<String>, requested: Set<DataOrigin>): Set<String>? {
        if (requested.isNotEmpty()) return requested.map { it.packageName }.toSet()
        for (p in watchWriters) if (p in available) return setOf(p)
        val rest = available.filter { it !in phoneWriters }
        if (rest.isNotEmpty()) return setOf(rest.first())
        return null
    }

    private fun <T : Record> List<T>.fromPreferred(requested: Set<DataOrigin>): List<T> {
        val pkgs = map { it.metadata.dataOrigin.packageName }.filter { it.isNotBlank() }.toSet()
        val pick = preferredPackages(pkgs, requested) ?: return this
        val filtered = filter { it.metadata.dataOrigin.packageName in pick }
        return filtered.ifEmpty { this }
    }

    private fun hcOrigins(requested: Set<DataOrigin>) =
        if (HealthHuawei.isHuaweiFamily()) emptySet() else requested

    private fun run(call: PluginCall, block: suspend () -> JSObject) {
        scope.launch {
            try {
                // Future.get, not kotlinx withTimeout: readRecords/aggregate are
                // binder calls, and a coroutine timeout cannot abort those. Honor
                // hangs here with every type already granted — JS then sits on
                // 0% because the first day's four reads never settle.
                val result = runQuery(10_000) {
                    runBlocking { block() }
                }
                call.resolve(result)
            } catch (e: SecurityException) {
                call.reject("not-authorized")
            } catch (e: Throwable) {
                val msg = e.message ?: "health-error"
                call.reject(if (msg.contains("timeout")) "timeout" else msg)
            }
        }
    }

    private fun huaweiRead(call: PluginCall, block: () -> Unit): Boolean {
        if (!HealthHuawei.shouldHandle(context)) return false
        scope.launch {
            try { block() } catch (e: Throwable) {
                call.reject(e.message ?: "health-error")
            }
        }
        return true
    }

    /* ============================ availability ============================ */

    @PluginMethod
    fun isAvailable(call: PluginCall) {
        scope.launch {
            if (HealthHuawei.shouldHandle(context)) {
                call.resolve(HealthHuawei.availability(context))
                return@launch
            }
            val ret = JSObject().put("provider", "health-connect")
            val status = runTimed(8_000) { HealthConnectClient.getSdkStatus(context) }
            if (status == null) {
                ret.put("available", false)
                ret.put("reason", "timeout")
                call.resolve(ret)
                return@launch
            }
            when (status) {
                // Do not call getOrCreate here. Status is enough to know the
                // permission picker can be launched; binding the client is a
                // later step and is what hung on Honor.
                HealthConnectClient.SDK_AVAILABLE -> ret.put("available", true)
                HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> {
                    ret.put("available", false)
                    ret.put("reason", "update-required")
                }
                else -> {
                    ret.put("available", false)
                    ret.put("reason", "not-installed")
                }
            }
            call.resolve(ret)
        }
    }

    /**
     * Always Health Connect — even on Honor/Huawei. The in-app picker often
     * never appears there, so Settings opens the store's own permission screen
     * and the pull button only reads.
     *
     * Prefer the per-app page (MANAGE_HEALTH_PERMISSIONS + package name) so the
     * user lands on Gemak's toggles rather than Health Connect's home.
     */
    private fun permissionScreenCandidates(): List<Intent> {
        val pkg = context.packageName
        val tries = mutableListOf<Intent>()
        if (Build.VERSION.SDK_INT >= 34) {
            // Per-app page first, then the platform's Health Connect home. On 14+
            // the OS owns Health Connect; the androidx actions below belong to the
            // standalone provider APK, which on these devices is a leftover shell.
            tries.add(Intent(ACTION_MANAGE_HEALTH_PERMISSIONS).putExtra(Intent.EXTRA_PACKAGE_NAME, pkg))
            tries.add(Intent(ACTION_HEALTH_HOME_SETTINGS))
        }
        tries.add(Intent(ACTION_ANDROIDX_MANAGE_HEALTH_PERMISSIONS).putExtra(Intent.EXTRA_PACKAGE_NAME, pkg))
        tries.add(Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS))
        if (Build.VERSION.SDK_INT < 34) tries.add(Intent(ACTION_HEALTH_HOME_SETTINGS))
        // Always reachable, and its Permissions entry gets to the same place.
        tries.add(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).setData(Uri.parse("package:$pkg")))
        return tries
    }

    /**
     * Starts the first candidate that resolves to a real activity.
     *
     * Resolving first is the whole point. startActivity() not throwing is not
     * evidence that anything opened: on Android 14+ the leftover
     * com.google.android.apps.healthdata shell still answers the androidx
     * actions, starts, and finishes immediately. That reported success while the
     * screen never changed and no error was shown — a tap that did nothing at
     * all, which is exactly how this looked on the phone.
     *
     * resolveActivity() is subject to package visibility, so every action here
     * has a matching <intent> in the manifest's <queries>.
     */
    private fun launchHealthConnectPermissionScreen(): String? {
        val pm = context.packageManager
        for (intent in permissionScreenCandidates()) {
            if (pm.resolveActivity(intent, 0) == null) continue
            if (startExternal(intent)) return intent.action ?: "opened"
        }
        // Nothing resolved. Rather than report failure while a working route
        // exists, try them once more without the resolve check — a device that
        // filters the lookup can still honour the start.
        for (intent in permissionScreenCandidates()) {
            if (startExternal(intent)) return (intent.action ?: "opened") + " (unverified)"
        }
        return null
    }

    /** Which candidates the device can actually open, for the connection check. */
    private fun permissionScreenReport(): JSArray {
        val pm = context.packageManager
        val out = JSArray()
        permissionScreenCandidates().forEach { intent ->
            val info = pm.resolveActivity(intent, 0)
            val label = (intent.action ?: "?").substringAfterLast('.')
            out.put(if (info == null) "$label: no" else "$label: ${info.activityInfo?.packageName ?: "yes"}")
        }
        return out
    }

    private fun startExternal(intent: Intent): Boolean {
        val act = activity
        return if (act != null) {
            runCatching { act.startActivity(Intent(intent)) }.isSuccess
        } else {
            runCatching {
                context.startActivity(Intent(intent).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }.isSuccess
        }
    }

    /**
     * The manual way in: Health Connect's own screen, where access can be granted
     * without the picker. Which deep link works depends on the platform version,
     * and getting this wrong is not cosmetic — it is the only route left when the
     * picker misbehaves.
     *
     *   · Android 14+  Health Connect is part of the OS and answers
     *                  android.health.connect.action.HEALTH_HOME_SETTINGS.
     *                  The androidx action resolves to nothing here, because the
     *                  standalone provider APK is not installed at all.
     *   · Android 13-  the provider APK handles the androidx action.
     *
     * Last resort is this app's own details page, which on every version has a
     * Permissions entry that reaches the same place in two more taps.
     */
    @PluginMethod
    fun openSettings(call: PluginCall) {
        // Kit is opt-in (configured APK). Everyone else — including Honor/Huawei
        // using Health Sync — goes to Health Connect.
        if (HealthHuawei.shouldHandle(context)) {
            if (HealthHuawei.openSettings(context)) {
                call.resolve(JSObject().put("via", "huawei-health"))
            } else {
                call.reject("no-settings")
            }
            return
        }
        val via = launchHealthConnectPermissionScreen()
        if (via != null) {
            call.resolve(JSObject().put("via", via))
            return
        }
        call.reject("no-settings")
    }

    /**
     * Honor/Huawei path: open Health Connect itself so the user can turn Gemak
     * on there. Never waits on getOrCreate, never launches the hanging picker.
     */
    @PluginMethod
    fun openHealthConnectPermissions(call: PluginCall) {
        val via = launchHealthConnectPermissionScreen()
        if (via != null) {
            call.resolve(JSObject().put("via", via))
            return
        }
        call.reject("no-settings")
    }

    @PluginMethod
    fun openPlayStore(call: PluginCall) {
        if (HealthHuawei.shouldHandle(context)) {
            if (HealthHuawei.openStore(context)) call.resolve()
            else call.reject("no-store")
            return
        }
        val pkg = "com.google.android.apps.healthdata"
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$pkg"))
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
        } catch (e: Throwable) {
            val web = Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$pkg"))
            web.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try { context.startActivity(web) } catch (e2: Throwable) { call.reject("no-store"); return }
        }
        call.resolve()
    }

    /* ============================ permissions ============================ */

    /**
     * What the platform says is granted, right now, without ever blocking
     * indefinitely.
     *
     * getGrantedPermissions() is a suspend call on a bound service, and on
     * Honor/Huawei that bind can sit forever — so it runs on a throwaway thread
     * behind a hard deadline like getOrCreate does. null means the bind timed
     * out (no-bind), which is different from an empty grant set.
     */
    private fun grantedNow(ms: Long = 6_000): Set<String>? = runTimed(ms) {
        runBlocking {
            val c = hcClient ?: HealthConnectClient.getOrCreate(context).also { hcClient = it }
            c.permissionController.getGrantedPermissions()
        }
    }

    @PluginMethod
    fun checkAuthorization(call: PluginCall) {
        scope.launch {
            if (HealthHuawei.shouldHandle(context)) {
                call.resolve(HealthHuawei.checkAuthorization(context))
                return@launch
            }
            val held = grantedNow()
            if (held == null) call.reject("no-bind")
            else call.resolve(grantedResult(held))
        }
    }

    @PluginMethod
    fun signOut(call: PluginCall) {
        scope.launch {
            if (HealthHuawei.shouldHandle(context)) HealthHuawei.signOut(context)
            call.resolve()
        }
    }

    /* -- the permission picker ------------------------------------------------
     *
     * One pending request at a time, and it is always answered. Three separate
     * things can settle it, because on real devices any one of them can fail:
     *
     *   1. the activity result, when the picker behaves
     *   2. coming back to the app, when the picker granted access and then lost
     *      the callback (common on Honor/Huawei)
     *   3. a watchdog, when the picker never appeared at all
     *
     * Whichever fires first wins; `settled` makes the other two no-ops. The one
     * thing that must never happen is none of them firing, which is what left
     * the connect sheet spinning on "Waiting for Health Connect…".
     */
    private var pendingCall: PluginCall? = null
    private var settled = true
    private var pendingHuawei = false
    // The picker is another activity, so this app pauses when it opens. Resuming
    // without having paused means the picker never came up at all — which is a
    // different failure, and not one the resume path should answer.
    private var pausedSinceLaunch = false
    private val main = Handler(Looper.getMainLooper())
    private val watchdog = Runnable { settlePending("watchdog") }
    // Honor/Huawei: the picker is another activity, so this app pauses when it
    // opens. Resuming without having paused means it never came up — open Health
    // Connect itself rather than waiting a minute and a half.
    private val noPickerFallback = Runnable {
        if (settled || pausedSinceLaunch) return@Runnable
        launchHealthConnectPermissionScreen()
    }

    @Synchronized
    private fun settlePending(@Suppress("UNUSED_PARAMETER") why: String) {
        if (settled) return
        val call = pendingCall ?: return
        settled = true
        pendingCall = null
        main.removeCallbacks(watchdog)
        main.removeCallbacks(noPickerFallback)
        scope.launch {
            if (pendingHuawei) {
                call.resolve(HealthHuawei.checkAuthorization(context))
                return@launch
            }
            val held = grantedNow()
            if (held == null) call.reject("no-bind")
            else call.resolve(grantedResult(held))
        }
    }

    @PluginMethod
    fun requestAuthorization(call: PluginCall) {
        if (HealthHuawei.shouldHandle(context)) {
            launchHuaweiAuth(call)
            return
        }
        val wanted = requestedScopes(call).ifEmpty { scopeNames() }
        val perms = wanted.mapNotNull { permissionFor(it) }.toMutableSet()
        // Asked for in the same sheet as the data types rather than sending the
        // user into Health Connect settings to find it. Without it every read is
        // capped at ~30 days from the first grant.
        if (call.getBoolean("requestHistoryAccess", false) == true) {
            perms.add(HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY)
        }
        // Do not call grantedNow first. Binding the client is a 4–8s stall on
        // Honor/Huawei and is not required to launch the picker — or to open
        // Health Connect's own permission screen, which is the path that works.
        scope.launch { launchPicker(call, perms) }
    }

    private fun launchHuaweiAuth(call: PluginCall) {
        val avail = HealthHuawei.availability(context)
        if (!avail.optBoolean("available", false)) {
            call.reject(avail.getString("reason") ?: "unavailable")
            return
        }
        val held = HealthHuawei.checkAuthorization(context)
        val already = held.optJSONArray("granted")
        if (already != null && already.length() > 0) {
            var hasHr = false
            for (i in 0 until already.length()) {
                if (already.optString(i) == "READ_HEART_RATE") hasHr = true
            }
            if (hasHr) { call.resolve(held); return }
        }
        val act = activity
        if (act == null) { call.reject("no-activity"); return }
        val intent = HealthHuawei.authIntent(context)
        if (intent == null) { call.reject("no-picker"); return }
        synchronized(this) {
            pendingCall = call
            settled = false
            pendingHuawei = true
            pausedSinceLaunch = false
        }
        act.runOnUiThread {
            try {
                startActivityForResult(call, intent, "huaweiAuthResult")
                main.postDelayed(watchdog, 25_000)
            } catch (e: Throwable) {
                synchronized(this) { settled = true; pendingCall = null; pendingHuawei = false }
                call.reject("no-picker")
            }
        }
    }

    @ActivityCallback
    fun huaweiAuthResult(call: PluginCall?, result: ActivityResult) {
        val pending = call ?: pendingCall
        if (settled && pending == null) return
        settled = true
        pendingCall = null
        pendingHuawei = false
        main.removeCallbacks(watchdog)
        main.removeCallbacks(noPickerFallback)
        val data = result.data
        scope.launch {
            (pending ?: call)?.resolve(HealthHuawei.parseAuth(context, data))
        }
    }

    private fun launchPicker(call: PluginCall, perms: Set<String>, droppedHistory: Boolean = false) {
        val act = activity
        if (act == null) { call.reject("no-activity"); return }
        val intent = try {
            PermissionController.createRequestPermissionResultContract()
                .createIntent(act, perms)
        } catch (e: Throwable) {
            if (!droppedHistory && perms.contains(HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY)) {
                launchPicker(call, perms - HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY, true)
                return
            }
            call.reject("no-picker")
            return
        }
        // NOTE: do not gate this on packageManager.resolveActivity().
        //
        // From Android 14 health permissions are ordinary runtime permissions,
        // so the contract hands back AndroidX's internal
        // "androidx.activity.result.contract.action.REQUEST_PERMISSIONS" intent,
        // which ActivityResultRegistry intercepts and turns into
        // requestPermissions(). No activity on the device declares that action,
        // so resolveActivity() is null for a perfectly good intent — checking it
        // rejected every request on 14+ before the picker was ever shown.
        synchronized(this) {
            pendingCall = call
            settled = false
            pendingHuawei = false
            pausedSinceLaunch = false
        }
        // Capacitor plugin methods run on a background HandlerThread.
        // ActivityResultLauncher.launch() must be called on the main thread;
        // Honor/Huawei otherwise swallow the start and never deliver a result.
        act.runOnUiThread {
            try {
                startActivityForResult(call, intent, "permissionResult")
                val inProcess = intent.action?.contains("REQUEST_PERMISSIONS") == true
                // Honor/Huawei: the picker almost never takes over the activity.
                // After a couple of seconds open Health Connect itself. On a
                // Pixel the system dialog is in-process and may not pause us —
                // don't overlay Health Connect on top of a working sheet.
                if (HealthHuawei.isHuaweiFamily() || !inProcess) {
                    main.postDelayed(noPickerFallback, 2_500)
                }
                main.postDelayed(watchdog, 25_000)
            } catch (e: Throwable) {
                synchronized(this) { settled = true; pendingCall = null }
                if (!droppedHistory && perms.contains(HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY)) {
                    launchPicker(call, perms - HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY, true)
                    return@runOnUiThread
                }
                call.reject("no-picker")
            }
        }
    }

    @ActivityCallback
    fun permissionResult(@Suppress("UNUSED_PARAMETER") call: PluginCall?, @Suppress("UNUSED_PARAMETER") result: ActivityResult) {
        // The result's own extras are not consistent between providers, and the
        // pending call is answered from the platform's granted set either way —
        // so there is nothing here to parse. This exists to settle the request
        // the moment the picker closes, before the watchdog would.
        settlePending("result")
    }

    override fun handleOnPause() {
        super.handleOnPause()
        if (!settled) pausedSinceLaunch = true
    }

    override fun handleOnResume() {
        super.handleOnResume()
        // Back in the app with a request still open: the picker closed without
        // delivering a result. Give the platform a moment to commit the grant,
        // then answer from what it actually holds.
        if (!settled && pausedSinceLaunch) {
            main.postDelayed({ settlePending("resume") }, 700)
        }
    }

    private fun grantedResult(held: Set<String>): JSObject {
        val granted = JSArray()
        scopeNames().forEach { name ->
            val p = permissionFor(name)
            if (p != null && held.contains(p)) granted.put(name)
        }
        val ret = JSObject()
        ret.put("granted", granted)
        ret.put("historyAccessAuthorized", held.contains(HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY))
        ret.put("provider", "health-connect")
        return ret
    }

    /* ============================ reads ============================ */

    @PluginMethod
    fun readHeartRate(call: PluginCall) {
        if (huaweiRead(call) { HealthHuawei.readHeartRate(context, call) }) return
        val filter = range(call) ?: run { call.reject("bad-range"); return }
        val origins = originsOf(call)
        run(call) {
            val recs = readAll<HeartRateRecord>(filter, hcOrigins(origins)).fromPreferred(origins)
            val out = JSArray()
            recs.forEach { rec ->
                rec.samples.forEach { s ->
                    val o = JSObject()
                    o.put("t", s.time.toEpochMilli())
                    o.put("bpm", s.beatsPerMinute)
                    out.put(o)
                }
            }
            JSObject().put("samples", out)
        }
    }

    @PluginMethod
    fun readRestingHeartRate(call: PluginCall) {
        if (huaweiRead(call) { HealthHuawei.readRestingHeartRate(context, call) }) return
        val filter = range(call) ?: run { call.reject("bad-range"); return }
        val origins = originsOf(call)
        run(call) {
            val out = JSArray()
            readAll<RestingHeartRateRecord>(filter, hcOrigins(origins)).fromPreferred(origins).forEach { rec ->
                val o = JSObject()
                o.put("t", rec.time.toEpochMilli())
                o.put("bpm", rec.beatsPerMinute)
                out.put(o)
            }
            JSObject().put("samples", out)
        }
    }

    /**
     * Blood oxygen and heart-rate variability, in one call.
     *
     * Both are night-time spot readings on a wrist device rather than continuous
     * measurements, so they come back as a small list and are only ever used as
     * a trend. Paired here because nothing in the app wants one without the
     * other, and one round trip beats two.
     */
    @PluginMethod
    fun readRecovery(call: PluginCall) {
        if (huaweiRead(call) { HealthHuawei.readRecovery(context, call) }) return
        val filter = range(call) ?: run { call.reject("bad-range"); return }
        val origins = originsOf(call)
        run(call) {
            val spo2 = JSArray()
            readAll<OxygenSaturationRecord>(filter, hcOrigins(origins)).fromPreferred(origins).forEach { rec ->
                val o = JSObject()
                o.put("t", rec.time.toEpochMilli())
                o.put("pct", rec.percentage.value)
                spo2.put(o)
            }
            val hrv = JSArray()
            readAll<HeartRateVariabilityRmssdRecord>(filter, hcOrigins(origins)).fromPreferred(origins).forEach { rec ->
                val o = JSObject()
                o.put("t", rec.time.toEpochMilli())
                o.put("ms", rec.heartRateVariabilityMillis)
                hrv.put(o)
            }
            JSObject().put("spo2", spo2).put("hrv", hrv)
        }
    }

    @PluginMethod
    fun readSleep(call: PluginCall) {
        if (huaweiRead(call) { HealthHuawei.readSleep(context, call) }) return
        val filter = range(call) ?: run { call.reject("bad-range"); return }
        val origins = originsOf(call)
        run(call) {
            val out = JSArray()
            readAll<SleepSessionRecord>(filter, hcOrigins(origins)).fromPreferred(origins).forEach { rec ->
                val o = JSObject()
                o.put("start", rec.startTime.toEpochMilli())
                o.put("end", rec.endTime.toEpochMilli())
                // Time in bed and time asleep are different numbers, and only the
                // second one is sleep. Bridges that pass no stages get null here
                // rather than a fabricated 100% efficiency.
                val asleep = rec.stages.filter { it.stage in ASLEEP_STAGES }
                if (asleep.isNotEmpty()) {
                    val ms = asleep.sumOf { it.endTime.toEpochMilli() - it.startTime.toEpochMilli() }
                    o.put("asleepMin", (ms / 60000L).toInt())
                }
                out.put(o)
            }
            JSObject().put("sessions", out)
        }
    }

    @PluginMethod
    fun readExerciseSessions(call: PluginCall) {
        if (huaweiRead(call) { HealthHuawei.readExerciseSessions(context, call) }) return
        val filter = range(call) ?: run { call.reject("bad-range"); return }
        val origins = originsOf(call)
        run(call) {
            val c = clientOrNull()
            val out = JSArray()
            readAll<ExerciseSessionRecord>(filter, hcOrigins(origins)).fromPreferred(origins).forEach { rec ->
                val o = JSObject()
                o.put("start", rec.startTime.toEpochMilli())
                o.put("end", rec.endTime.toEpochMilli())
                o.put("type", exerciseName(rec.exerciseType))
                // The session record carries no energy of its own, so the burn is
                // aggregated over the window it occupied.
                if (c != null) {
                    val kcal = runCatching {
                        c.aggregate(
                            AggregateRequest(
                                metrics = setOf(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL),
                                timeRangeFilter = TimeRangeFilter.between(rec.startTime, rec.endTime),
                                dataOriginFilter = origins
                            )
                        )[ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL]?.inKilocalories
                    }.getOrNull()
                    if (kcal != null) o.put("kcal", kcal)
                }
                out.put(o)
            }
            JSObject().put("sessions", out)
        }
    }

    @PluginMethod
    fun aggregate(call: PluginCall) {
        if (huaweiRead(call) { HealthHuawei.aggregate(context, call) }) return
        val filter = range(call) ?: run { call.reject("bad-range"); return }
        val requested = originsOf(call)
        val wanted = call.getArray("metrics")?.let { arr ->
            (0 until arr.length()).mapNotNull { runCatching { arr.getString(it) }.getOrNull() }
        } ?: listOf("steps", "activeCalories", "totalCalories")

        // Each metric has its own deadline. Bundling steps+calories in one
        // 10s Future.get is what froze Pull at 15%: steps had already returned
        // (the probe) and calories held the binder until the whole call died,
        // discarding the steps. Honor never uses HC aggregate() — it hangs.
        scope.launch {
            try {
                if (clientOrNull() == null) {
                    call.reject("no-bind")
                    return@launch
                }
                val honor = HealthHuawei.isHuaweiFamily()
                val ret = JSObject()
                for (metric in wanted) {
                    val v = runTimed(3_500) {
                        runBlocking { readMetric(metric, filter, requested, honor) }
                    } ?: continue
                    when (metric) {
                        "steps" -> ret.put("steps", v)
                        "activeCalories" -> ret.put("activeCalories", v)
                        "totalCalories" -> ret.put("totalCalories", v)
                    }
                }
                call.resolve(ret)
            } catch (e: SecurityException) {
                call.reject("not-authorized")
            } catch (e: Throwable) {
                val msg = e.message ?: "health-error"
                call.reject(if (msg.contains("timeout")) "timeout" else msg)
            }
        }
    }

    private suspend fun readMetric(
        metric: String,
        filter: TimeRangeFilter,
        requested: Set<DataOrigin>,
        honor: Boolean,
    ): Double {
        // Honor: always read every origin then pick in memory. Passing a
        // dataOriginFilter on that binder is another hang. Docs say
        // aggregate() dedupes; we do the same by preferring Health Sync.
        val req = if (honor) emptySet() else requested
        return when (metric) {
            "steps" -> readAll<StepsRecord>(filter, req).fromPreferred(requested).sumOf { it.count }.toDouble()
            "activeCalories" -> readAll<ActiveCaloriesBurnedRecord>(filter, req)
                .fromPreferred(requested).sumOf { it.energy.inKilocalories }
            "totalCalories" -> readAll<TotalCaloriesBurnedRecord>(filter, req)
                .fromPreferred(requested).sumOf { it.energy.inKilocalories }
            else -> 0.0
        }
    }

    /**
     * A one-day steps read with the same timeout as every other query.
     * The pull starts here so the log can say "the store answers" or
     * "the store is hanging" before walking days.
     */
    @PluginMethod
    fun probe(call: PluginCall) {
        if (huaweiRead(call) { HealthHuawei.aggregate(context, call) }) return
        val now = System.currentTimeMillis()
        val start = call.getLong("start") ?: (now - 86_400_000L)
        val end = call.getLong("end") ?: now
        if (end <= start) { call.reject("bad-range"); return }
        val filter = TimeRangeFilter.between(Instant.ofEpochMilli(start), Instant.ofEpochMilli(end))
        val t0 = System.currentTimeMillis()
        run(call) {
            val recs = readAll<StepsRecord>(filter, emptySet())
            val preferred = recs.fromPreferred(emptySet())
            val origins = JSArray()
            recs.map { it.metadata.dataOrigin.packageName }.filter { it.isNotBlank() }.distinct()
                .forEach { origins.put(it) }
            val picked = preferredPackages(
                recs.map { it.metadata.dataOrigin.packageName }.filter { it.isNotBlank() }.toSet(),
                emptySet(),
            )?.firstOrNull()
            JSObject()
                .put("records", preferred.size)
                .put("steps", preferred.sumOf { it.count })
                .put("ms", System.currentTimeMillis() - t0)
                .put("origins", origins)
                .put("origin", picked ?: "")
        }
    }

    /**
     * Which apps are writing into Health Connect on this phone.
     *
     * Shown during setup so the user can point the app at the watch bridge rather
     * than at the phone's own step counter — otherwise both get counted and a
     * 6,000-step day reads as 12,000.
     */
    @PluginMethod
    fun listOrigins(call: PluginCall) {
        if (huaweiRead(call) { HealthHuawei.listOrigins(context, call) }) return
        val filter = range(call) ?: run { call.reject("bad-range"); return }
        run(call) {
            val pkgs = LinkedHashSet<String>()
            readAll<StepsRecord>(filter, emptySet()).forEach { pkgs.add(it.metadata.dataOrigin.packageName) }
            readAll<HeartRateRecord>(filter, emptySet()).forEach { pkgs.add(it.metadata.dataOrigin.packageName) }
            val pm = context.packageManager
            val out = JSArray()
            pkgs.filter { it.isNotBlank() }.forEach { pkg ->
                val o = JSObject()
                o.put("pkg", pkg)
                o.put("label", runCatching {
                    pm.getApplicationLabel(pm.getApplicationInfo(pkg, PackageManager.GET_META_DATA)).toString()
                }.getOrDefault(pkg))
                out.put(o)
            }
            JSObject().put("origins", out)
        }
    }

    /**
     * Everything needed to tell, from a phone that is not in front of me, why a
     * link failed. Every step is timed out separately and reported rather than
     * thrown, so this call always returns — a diagnostic that can hang is worse
     * than none.
     */
    @PluginMethod
    fun diagnose(call: PluginCall) {
        scope.launch {
            if (HealthHuawei.shouldHandle(context)) {
                call.resolve(HealthHuawei.diagnose(context))
                return@launch
            }
            val out = JSObject().put("provider", "health-connect")
            out.put("sdkInt", Build.VERSION.SDK_INT)
            out.put("device", Build.MANUFACTURER + " " + Build.MODEL)

            val status = runTimed(6_000) { HealthConnectClient.getSdkStatus(context) }
            out.put("sdkStatus", status ?: -1)
            out.put("sdkStatusText", when (status) {
                null -> "timed out"
                HealthConnectClient.SDK_AVAILABLE -> "available"
                HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "update required"
                else -> "not installed"
            })

            val pm = context.packageManager
            out.put("providerInstalled", runCatching {
                pm.getPackageInfo("com.google.android.apps.healthdata", 0); true
            }.getOrDefault(false))

            // The picker intent, as the library actually builds it on this OS
            // version. `resolves` being false is expected and fine on 14+ — the
            // action is handled inside AndroidX, not by any activity.
            val perms = scopeNames().mapNotNull { permissionFor(it) }.toSet()
            val act = activity
            if (act != null) {
                val intent = runCatching {
                    PermissionController.createRequestPermissionResultContract().createIntent(act, perms)
                }.getOrNull()
                out.put("pickerAction", intent?.action ?: "could not build")
                out.put("pickerPackage", intent?.`package` ?: "none")
                out.put("pickerResolves", intent != null && pm.resolveActivity(intent, 0) != null)
                // Which settings deep links this device can actually open, and
                // which app answers each. A route that reports "no" here but was
                // being started anyway is a tap that does nothing.
                out.put("settingsRoutes", permissionScreenReport())
            } else {
                out.put("pickerAction", "no activity")
            }

            val bound = runTimed(6_000) { HealthConnectClient.getOrCreate(context); true }
            out.put("clientBinds", bound == true)

            // null means the read itself timed out, which is a different problem
            // from "nothing is granted" — grantedCount carries that as -1.
            val held = grantedNow(6_000)
            val names = JSArray()
            (held ?: emptySet()).forEach { names.put(it.substringAfterLast('.')) }
            out.put("granted", names)
            out.put("grantedCount", held?.size ?: -1)

            // Whether the manifest declarations survived into the installed APK.
            // If this is 0 the app cannot appear in Health Connect at all.
            val declared = runCatching {
                pm.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
                    .requestedPermissions?.count { it.startsWith("android.permission.health.") } ?: 0
            }.getOrDefault(-1)
            out.put("declaredHealthPermissions", declared)

            // A one-day steps read and a one-metric aggregate, each timed out on
            // its own. Permissions can all be granted while these still hang —
            // which is the 0% pull — and the two answers tell them apart:
            // readRecords working with aggregate stuck is the Honor case the
            // daily pull now sums around.
            if (bound == true && held != null && held.isNotEmpty()) {
                val probeFilter = TimeRangeFilter.between(
                    Instant.now().minusSeconds(86_400), Instant.now()
                )
                val probeT0 = System.currentTimeMillis()
                val probeRecs = runTimed(6_000) {
                    runBlocking {
                        val c = hcClient ?: HealthConnectClient.getOrCreate(context).also { hcClient = it }
                        c.readRecords(
                            ReadRecordsRequest<StepsRecord>(
                                timeRangeFilter = probeFilter,
                                dataOriginFilter = emptySet(),
                                ascendingOrder = true,
                                pageSize = 100,
                                pageToken = null
                            )
                        ).records
                    }
                }
                out.put("probeMs", System.currentTimeMillis() - probeT0)
                if (probeRecs == null) {
                    out.put("probeOk", false)
                    out.put("probeReason", "timeout")
                } else {
                    out.put("probeOk", true)
                    out.put("probeRecords", probeRecs.size)
                    out.put("probeSteps", probeRecs.sumOf { it.count })
                    val pkgs = JSArray()
                    probeRecs.map { it.metadata.dataOrigin.packageName }
                        .filter { it.isNotBlank() }.distinct()
                        .forEach { pkgs.put(it) }
                    out.put("probeOrigins", pkgs)
                }

                val aggT0 = System.currentTimeMillis()
                val aggSteps = runTimed(5_000) {
                    runBlocking {
                        val c = hcClient ?: return@runBlocking null
                        c.aggregate(
                            AggregateRequest(
                                metrics = setOf(StepsRecord.COUNT_TOTAL),
                                timeRangeFilter = probeFilter,
                                dataOriginFilter = emptySet()
                            )
                        )[StepsRecord.COUNT_TOTAL]
                    }
                }
                out.put("probeAggregateMs", System.currentTimeMillis() - aggT0)
                out.put("probeAggregate", if (aggSteps == null) "timeout" else aggSteps.toString())
            }

            call.resolve(out)
        }
    }

    companion object {
        /** Platform Health Connect, Android 14+. Not exposed by the androidx client. */
        const val ACTION_HEALTH_HOME_SETTINGS = "android.health.connect.action.HEALTH_HOME_SETTINGS"
        const val ACTION_MANAGE_HEALTH_PERMISSIONS = "android.health.connect.action.MANAGE_HEALTH_PERMISSIONS"
        const val ACTION_ANDROIDX_MANAGE_HEALTH_PERMISSIONS = "androidx.health.ACTION_MANAGE_HEALTH_PERMISSIONS"

        private val ASLEEP_STAGES = setOf(
            SleepSessionRecord.STAGE_TYPE_SLEEPING,
            SleepSessionRecord.STAGE_TYPE_LIGHT,
            SleepSessionRecord.STAGE_TYPE_DEEP,
            SleepSessionRecord.STAGE_TYPE_REM
        )

        /**
         * Only the types the app actually distinguishes. Everything else comes back
         * as "workout" — the UI groups them all as "cardio outside the gym", so a
         * hundred-name lookup table would be dead weight.
         */
        fun exerciseName(type: Int): String = when (type) {
            ExerciseSessionRecord.EXERCISE_TYPE_RUNNING,
            ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL -> "running"
            ExerciseSessionRecord.EXERCISE_TYPE_WALKING -> "walking"
            ExerciseSessionRecord.EXERCISE_TYPE_BIKING,
            ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY -> "cycling"
            ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL,
            ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_OPEN_WATER -> "swimming"
            ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING,
            ExerciseSessionRecord.EXERCISE_TYPE_WEIGHTLIFTING -> "strength"
            ExerciseSessionRecord.EXERCISE_TYPE_HIKING -> "hiking"
            else -> "workout"
        }
    }
}
