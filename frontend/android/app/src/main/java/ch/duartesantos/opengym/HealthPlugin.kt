package ch.duartesantos.opengym

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.activity.result.ActivityResult
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.aggregate.AggregateMetric
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
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
import java.time.Instant

/**
 * Health Connect bridge — read only.
 *
 * Written in Kotlin because every call on HealthConnectClient is a suspend
 * function; calling those from Java means hand-rolling Continuations, which is
 * the kind of code nobody wants to maintain. This is also why the app has its
 * own plugin instead of one off npm: on the Capacitor 7 line, no published
 * plugin exposes sleep or resting heart rate, and those two are what the
 * readiness features are built on.
 *
 * Nothing here reaches a network. Health Connect is an on-device store that
 * other apps write into — for a Huawei watch that is Health Sync, mirroring out
 * of Huawei Health. The app never sees a Google or Huawei account.
 *
 * Contract with the JS side (lib/health-connect.js):
 *   · all instants are epoch milliseconds, in and out
 *   · a read with nothing recorded resolves with an empty list, it never rejects
 *   · rejections use stable codes, because each needs a different fix from the
 *     user: "not-authorized" is a permission, "unavailable" is a missing app
 */
@CapacitorPlugin(name = "Health")
class HealthPlugin : Plugin() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    // A page bigger than this is refused by the platform. Heart rate over a full
    // day comfortably exceeds one page, so every read below follows pageToken.
    private val pageSize = 1000

    private val client: HealthConnectClient? by lazy {
        try { HealthConnectClient.getOrCreate(context) } catch (e: Throwable) { null }
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
        else -> null
    }

    private fun scopeNames(): List<String> = listOf(
        "READ_HEART_RATE", "READ_RESTING_HEART_RATE", "READ_SLEEP", "READ_STEPS",
        "READ_ACTIVE_CALORIES_BURNED", "READ_TOTAL_CALORIES_BURNED", "READ_EXERCISE"
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
        val c = client ?: return emptyList()
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

    private fun run(call: PluginCall, block: suspend () -> JSObject) {
        scope.launch {
            try {
                call.resolve(block())
            } catch (e: SecurityException) {
                call.reject("not-authorized")
            } catch (e: Throwable) {
                call.reject(e.message ?: "health-error")
            }
        }
    }

    /* ============================ availability ============================ */

    @PluginMethod
    fun isAvailable(call: PluginCall) {
        val ret = JSObject()
        when (HealthConnectClient.getSdkStatus(context)) {
            HealthConnectClient.SDK_AVAILABLE -> {
                ret.put("available", client != null)
                if (client == null) ret.put("reason", "init-failed")
            }
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

    @PluginMethod
    fun openSettings(call: PluginCall) {
        // ACTION_HEALTH_HOME_SETTINGS is the deep link Health Connect itself
        // publishes; on 14+ it lands in the OS settings page instead.
        val intent = Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try { context.startActivity(intent); call.resolve() } catch (e: Throwable) { call.reject("no-settings") }
    }

    @PluginMethod
    fun openPlayStore(call: PluginCall) {
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

    @PluginMethod
    fun checkAuthorization(call: PluginCall) {
        run(call) {
            val c = client ?: return@run JSObject().put("granted", JSArray())
            val held = c.permissionController.getGrantedPermissions()
            grantedResult(held)
        }
    }

    @PluginMethod
    fun requestAuthorization(call: PluginCall) {
        val c = client
        if (c == null) { call.reject("unavailable"); return }

        val wanted = requestedScopes(call).ifEmpty { scopeNames() }
        val perms = wanted.mapNotNull { permissionFor(it) }.toMutableSet()
        // Asked for in the same sheet as the data types rather than sending the
        // user into Health Connect settings to find it. Without it every read is
        // capped at ~30 days from the first grant.
        if (call.getBoolean("requestHistoryAccess", false) == true) {
            perms.add(HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY)
        }

        val intent = PermissionController.createRequestPermissionResultContract()
            .createIntent(context, perms)
        startActivityForResult(call, intent, "permissionResult")
    }

    @ActivityCallback
    private fun permissionResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        // The contract's own result is parsed inconsistently across provider
        // versions; asking the controller what is actually held is the answer
        // that matches what the next read will be allowed to do.
        run(call) {
            val c = client ?: return@run JSObject().put("granted", JSArray())
            grantedResult(c.permissionController.getGrantedPermissions())
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
        return ret
    }

    /* ============================ reads ============================ */

    @PluginMethod
    fun readHeartRate(call: PluginCall) {
        val filter = range(call) ?: run { call.reject("bad-range"); return }
        val origins = originsOf(call)
        run(call) {
            val recs = readAll<HeartRateRecord>(filter, origins)
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
        val filter = range(call) ?: run { call.reject("bad-range"); return }
        val origins = originsOf(call)
        run(call) {
            val out = JSArray()
            readAll<RestingHeartRateRecord>(filter, origins).forEach { rec ->
                val o = JSObject()
                o.put("t", rec.time.toEpochMilli())
                o.put("bpm", rec.beatsPerMinute)
                out.put(o)
            }
            JSObject().put("samples", out)
        }
    }

    @PluginMethod
    fun readSleep(call: PluginCall) {
        val filter = range(call) ?: run { call.reject("bad-range"); return }
        val origins = originsOf(call)
        run(call) {
            val out = JSArray()
            readAll<SleepSessionRecord>(filter, origins).forEach { rec ->
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
        val filter = range(call) ?: run { call.reject("bad-range"); return }
        val origins = originsOf(call)
        run(call) {
            val c = client
            val out = JSArray()
            readAll<ExerciseSessionRecord>(filter, origins).forEach { rec ->
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
        val filter = range(call) ?: run { call.reject("bad-range"); return }
        val origins = originsOf(call)
        val wanted = call.getArray("metrics")?.let { arr ->
            (0 until arr.length()).mapNotNull { runCatching { arr.getString(it) }.getOrNull() }
        } ?: listOf("steps", "activeCalories", "totalCalories")

        run(call) {
            val c = client ?: return@run JSObject()
            val metrics = mutableSetOf<AggregateMetric<*>>()
            if (wanted.contains("steps")) metrics.add(StepsRecord.COUNT_TOTAL)
            if (wanted.contains("activeCalories")) metrics.add(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL)
            if (wanted.contains("totalCalories")) metrics.add(TotalCaloriesBurnedRecord.ENERGY_TOTAL)
            if (metrics.isEmpty()) return@run JSObject()

            // One aggregate call per window rather than one per metric: same
            // cursor walk, a third of the permission checks.
            val res = c.aggregate(
                AggregateRequest(metrics = metrics, timeRangeFilter = filter, dataOriginFilter = origins)
            )
            val ret = JSObject()
            if (metrics.contains(StepsRecord.COUNT_TOTAL)) {
                res[StepsRecord.COUNT_TOTAL]?.let { ret.put("steps", it) }
            }
            if (metrics.contains(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL)) {
                res[ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL]?.let { ret.put("activeCalories", it.inKilocalories) }
            }
            if (metrics.contains(TotalCaloriesBurnedRecord.ENERGY_TOTAL)) {
                res[TotalCaloriesBurnedRecord.ENERGY_TOTAL]?.let { ret.put("totalCalories", it.inKilocalories) }
            }
            ret
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

    companion object {
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
