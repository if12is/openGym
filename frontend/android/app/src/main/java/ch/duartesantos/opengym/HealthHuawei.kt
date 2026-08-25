package ch.duartesantos.opengym

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import com.huawei.hmf.tasks.Task
import com.huawei.hmf.tasks.Tasks
import com.huawei.hms.api.ConnectionResult
import com.huawei.hms.api.HuaweiApiAvailability
import com.huawei.hms.hihealth.HuaweiHiHealth
import com.huawei.hms.hihealth.data.ActivityRecord
import com.huawei.hms.hihealth.data.DataType
import com.huawei.hms.hihealth.data.Field
import com.huawei.hms.hihealth.data.SamplePoint
import com.huawei.hms.hihealth.data.Scopes
import com.huawei.hms.hihealth.options.ActivityRecordReadOptions
import com.huawei.hms.hihealth.options.ReadOptions
import com.huawei.hms.hihealth.result.HealthKitAuthResult
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * Huawei Health Kit backend for the Health Capacitor plugin.
 *
 * Preferred on Huawei/Honor (Health Connect's client bind hangs there) and on
 * any phone that has HMS Core + Huawei Health. Reads go through DataController
 * after the user signs in with a Huawei ID and authorises the Health app.
 *
 * Same JS contract as Health Connect: epoch milliseconds, empty lists when
 * nothing is recorded, stable reject codes.
 */
object HealthHuawei {

    const val PKG_HEALTH = "com.huawei.health"
    const val PKG_HONOR_HEALTH = "com.hihonor.health"
    private const val PREF = "health_huawei"
    private const val PREF_GRANTED = "granted"
    private const val AWAIT_MS = 20_000L

    fun isHuaweiFamily(): Boolean {
        val m = Build.MANUFACTURER.lowercase(Locale.US)
        val b = Build.BRAND.lowercase(Locale.US)
        return listOf(m, b).any {
            it.contains("huawei") || it.contains("honor") || it.contains("hihonor")
        }
    }

    fun isConfigured(ctx: Context): Boolean {
        val id = runCatching {
            ctx.getString(ctx.resources.getIdentifier("huawei_app_id", "string", ctx.packageName))
        }.getOrNull()?.trim().orEmpty()
        return id.isNotEmpty() && id != "0" && id != "YOUR_HUAWEI_APP_ID"
    }

    fun healthAppInstalled(ctx: Context): Boolean =
        packageInstalled(ctx, PKG_HEALTH) || packageInstalled(ctx, PKG_HONOR_HEALTH)

    fun hmsAvailable(ctx: Context): Boolean = try {
        HuaweiApiAvailability.getInstance()
            .isHuaweiMobileServicesAvailable(ctx) == ConnectionResult.SUCCESS
    } catch (e: Throwable) {
        false
    }

    /**
     * Take this path instead of Health Connect.
     *
     * Only when AppGallery Connect is actually wired. An Honor/Huawei phone
     * with Health Sync data in Health Connect must not be sent to a Kit that
     * has no App ID — that is what made the connect sheet look frozen, and
     * it hid the Health Connect permission screen those phones need.
     */
    fun shouldHandle(ctx: Context): Boolean {
        return try {
            if (!isConfigured(ctx)) return false
            isHuaweiFamily() || (hmsAvailable(ctx) && healthAppInstalled(ctx))
        } catch (e: Throwable) {
            false
        }
    }

    fun availability(ctx: Context): JSObject {
        val ret = JSObject().put("provider", "huawei")
        if (!isConfigured(ctx)) {
            return ret.put("available", false).put("reason", "not-configured")
        }
        if (!hmsAvailable(ctx)) {
            return ret.put("available", false).put("reason", "no-hms")
        }
        if (!healthAppInstalled(ctx)) {
            return ret.put("available", false).put("reason", "no-health-app")
        }
        return ret.put("available", true)
    }

    fun authIntent(ctx: Context): Intent? {
        val scopes = requestedScopes()
        if (scopes.isEmpty()) return null
        val setting = runCatching { HuaweiHiHealth.getSettingController(ctx) }.getOrNull()
            ?: return null
        // true → Huawei Health itself is asked, so data comes from the account
        // the watch already syncs to, not from an empty Kit store.
        return runCatching { setting.requestAuthorizationIntent(scopes, true) }.getOrNull()
    }

    fun parseAuth(ctx: Context, data: Intent?): JSObject {
        val setting = runCatching { HuaweiHiHealth.getSettingController(ctx) }.getOrNull()
        val result: HealthKitAuthResult? = runCatching {
            setting?.parseHealthKitAuthResultFromIntent(data)
        }.getOrNull()
        if (result == null || !result.isSuccess) {
            saveGranted(ctx, emptyList())
            return grantedResult(emptyList())
        }
        val names = scopeNames()
        saveGranted(ctx, names)
        return grantedResult(names).put("historyAccessAuthorized", true)
    }

    fun checkAuthorization(ctx: Context): JSObject {
        val held = if (healthAppAuthorized(ctx)) savedGranted(ctx).ifEmpty { scopeNames() }
        else emptyList()
        return grantedResult(held).put("historyAccessAuthorized", held.isNotEmpty())
    }

    fun signOut(ctx: Context) {
        saveGranted(ctx, emptyList())
        runCatching {
            val setting = HuaweiHiHealth.getSettingController(ctx)
            await(setting.disableHiHealth(), 8_000)
        }
    }

    fun openSettings(ctx: Context): Boolean {
        for (pkg in listOf(PKG_HEALTH, PKG_HONOR_HEALTH)) {
            val launch = ctx.packageManager.getLaunchIntentForPackage(pkg) ?: continue
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (runCatching { ctx.startActivity(launch) }.isSuccess) return true
        }
        return false
    }

    fun openStore(ctx: Context): Boolean {
        val pkg = if (packageInstalled(ctx, PKG_HONOR_HEALTH) && !packageInstalled(ctx, PKG_HEALTH))
            PKG_HONOR_HEALTH else PKG_HEALTH
        val market = Intent(Intent.ACTION_VIEW, Uri.parse("appmarket://details?id=$pkg"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (runCatching { ctx.startActivity(market) }.isSuccess) return true
        val web = Intent(
            Intent.ACTION_VIEW,
            Uri.parse("https://appgallery.huawei.com/app/C27162")
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return runCatching { ctx.startActivity(web) }.isSuccess
    }

    /* ============================ reads ============================ */

    fun readHeartRate(ctx: Context, call: PluginCall) {
        val range = rangeOf(call) ?: return
        runRead(call) {
            val samples = JSArray()
            numericSamples(
                ctx,
                listOf("DT_INSTANTANEOUS_HEART_RATE", "DT_INSTANTANEOUS_EXERCISE_HEART_RATE"),
                listOf("FIELD_BPM", "FIELD_AVG"),
                range.first, range.second
            ).forEach { (t, v) ->
                if (v > 0) samples.put(JSObject().put("t", t).put("bpm", v.toInt()))
            }
            JSObject().put("samples", samples)
        }
    }

    fun readRestingHeartRate(ctx: Context, call: PluginCall) {
        val range = rangeOf(call) ?: return
        runRead(call) {
            val samples = JSArray()
            numericSamples(
                ctx,
                listOf("DT_INSTANTANEOUS_RESTING_HEART_RATE"),
                listOf("FIELD_BPM", "FIELD_AVG"),
                range.first, range.second
            ).forEach { (t, v) ->
                if (v > 0) samples.put(JSObject().put("t", t).put("bpm", v.toInt()))
            }
            JSObject().put("samples", samples)
        }
    }

    fun readRecovery(ctx: Context, call: PluginCall) {
        val range = rangeOf(call) ?: return
        runRead(call) {
            val spo2 = JSArray()
            numericSamples(
                ctx,
                listOf("DT_INSTANTANEOUS_SPO2", "DT_INSTANTANEOUS_OXYGEN_SATURATION"),
                listOf("FIELD_SATURATION", "FIELD_SPO2", "FIELD_PERCENTAGE"),
                range.first, range.second
            ).forEach { (t, v) ->
                val pct = if (v <= 1.0) v * 100.0 else v
                if (pct > 0) spo2.put(JSObject().put("t", t).put("pct", pct))
            }
            val hrv = JSArray()
            numericSamples(
                ctx,
                listOf(
                    "DT_INSTANTANEOUS_HRV",
                    "DT_INSTANTANEOUS_HEART_RATE_VARIABILITY",
                    "DT_INSTANTANEOUS_RMSSD"
                ),
                listOf("FIELD_HRV", "FIELD_RMSSD", "FIELD_AVG", "FIELD_STRESS_SCORE"),
                range.first, range.second
            ).forEach { (t, v) ->
                if (v > 0) hrv.put(JSObject().put("t", t).put("ms", v))
            }
            JSObject().put("spo2", spo2).put("hrv", hrv)
        }
    }

    fun readSleep(ctx: Context, call: PluginCall) {
        val range = rangeOf(call) ?: return
        runRead(call) {
            val pts = sleepPoints(ctx, range.first, range.second)
            JSObject().put("sessions", clusterSleep(pts))
        }
    }

    fun readExerciseSessions(ctx: Context, call: PluginCall) {
        val range = rangeOf(call) ?: return
        runRead(call) {
            val out = JSArray()
            val controller = HuaweiHiHealth.getActivityRecordsController(ctx)
            val req = ActivityRecordReadOptions.Builder()
                .setTimeInterval(range.first, range.second, TimeUnit.MILLISECONDS)
                .readActivityRecordsFromAllApps()
                .build()
            val reply = await(controller.getActivityRecord(req)) ?: return@runRead JSObject().put("sessions", out)
            reply.activityRecords.orEmpty().forEach { rec ->
                if (rec == null) return@forEach
                val start = rec.getStartTime(TimeUnit.MILLISECONDS)
                val end = rec.getEndTime(TimeUnit.MILLISECONDS)
                if (end <= start) return@forEach
                val o = JSObject()
                o.put("start", start)
                o.put("end", end)
                o.put("type", exerciseName(rec.activityType))
                o.put("kcal", caloriesOf(rec))
                out.put(o)
            }
            JSObject().put("sessions", out)
        }
    }

    fun aggregate(ctx: Context, call: PluginCall) {
        val range = rangeOf(call) ?: return
        val wanted = call.getArray("metrics")?.let { arr ->
            (0 until arr.length()).mapNotNull { runCatching { arr.getString(it) }.getOrNull() }
        } ?: listOf("steps", "activeCalories", "totalCalories")
        runRead(call) {
            val ret = JSObject()
            val day = yyyymmdd(range.first)
            val endDay = yyyymmdd(range.second - 1)
            if (wanted.contains("steps")) {
                dailySum(ctx, "DT_CONTINUOUS_STEPS_DELTA", listOf("FIELD_STEPS_DELTA", "FIELD_STEPS"), day, endDay)
                    ?.let { ret.put("steps", it.toLong()) }
                    ?: sumNumeric(ctx, "DT_CONTINUOUS_STEPS_DELTA", listOf("FIELD_STEPS_DELTA", "FIELD_STEPS"), range)
                        ?.let { ret.put("steps", it.toLong()) }
            }
            if (wanted.contains("activeCalories") || wanted.contains("totalCalories")) {
                val kcal = dailySum(
                    ctx, "DT_CONTINUOUS_CALORIES_BURNT",
                    listOf("FIELD_CALORIES", "FIELD_CALORIES_TOTAL"), day, endDay
                ) ?: sumNumeric(
                    ctx, "DT_CONTINUOUS_CALORIES_BURNT",
                    listOf("FIELD_CALORIES", "FIELD_CALORIES_TOTAL"), range
                )
                if (kcal != null) {
                    if (wanted.contains("activeCalories")) ret.put("activeCalories", kcal)
                    if (wanted.contains("totalCalories")) ret.put("totalCalories", kcal)
                }
            }
            ret
        }
    }

    fun listOrigins(ctx: Context, call: PluginCall) {
        runRead(call) {
            val pkg = when {
                packageInstalled(ctx, PKG_HEALTH) -> PKG_HEALTH
                packageInstalled(ctx, PKG_HONOR_HEALTH) -> PKG_HONOR_HEALTH
                else -> PKG_HEALTH
            }
            val o = JSObject().put("pkg", pkg).put("label", "Huawei Health")
            JSObject().put("origins", JSArray().put(o))
        }
    }

    fun diagnose(ctx: Context): JSObject {
        val out = JSObject()
        out.put("provider", "huawei")
        out.put("sdkInt", Build.VERSION.SDK_INT)
        out.put("device", Build.MANUFACTURER + " " + Build.MODEL)
        out.put("appIdConfigured", isConfigured(ctx))
        out.put("hmsAvailable", hmsAvailable(ctx))
        out.put("huaweiHealthInstalled", healthAppInstalled(ctx))
        out.put("healthAuthorized", healthAppAuthorized(ctx))
        val granted = savedGranted(ctx)
        out.put("grantedCount", granted.size)
        val names = JSArray()
        granted.forEach { names.put(it) }
        out.put("granted", names)
        out.put("sdkStatusText", when {
            !isConfigured(ctx) -> "app id missing"
            !hmsAvailable(ctx) -> "HMS Core missing"
            !healthAppInstalled(ctx) -> "Huawei Health missing"
            else -> "huawei kit"
        })
        out.put("sdkStatus", if (hmsAvailable(ctx)) 1 else 0)
        out.put("clientBinds", hmsAvailable(ctx) && isConfigured(ctx))
        out.put("providerInstalled", healthAppInstalled(ctx))
        out.put("pickerAction", "huawei-health-auth")
        out.put("pickerResolves", authIntent(ctx) != null)
        out.put("declaredHealthPermissions", requestedScopes().size)
        return out
    }

    /* ============================ internals ============================ */

    private fun rangeOf(call: PluginCall): Pair<Long, Long>? {
        val start = call.getLong("start") ?: run { call.reject("bad-range"); return null }
        val end = call.getLong("end") ?: run { call.reject("bad-range"); return null }
        if (end <= start) { call.reject("bad-range"); return null }
        return start to end
    }

    private fun runRead(call: PluginCall, block: () -> JSObject) {
        try {
            call.resolve(block())
        } catch (e: SecurityException) {
            call.reject("not-authorized")
        } catch (e: Throwable) {
            if (isAuthError(e)) call.reject("not-authorized")
            else call.reject(e.message ?: "health-error")
        }
    }

    private fun isAuthError(e: Throwable): Boolean {
        val msg = (e.message ?: "").lowercase(Locale.US)
        return msg.contains("not-authorized") || msg.contains("50005") ||
            msg.contains("50011") || msg.contains("50038") || msg.contains("unauthor") ||
            msg.contains("sign") && msg.contains("in")
    }

    private fun numericSamples(
        ctx: Context,
        typeNames: List<String>,
        fieldNames: List<String>,
        start: Long,
        end: Long
    ): List<Pair<Long, Double>> {
        val out = ArrayList<Pair<Long, Double>>()
        typeNames.forEach { name ->
            val dt = dataType(name) ?: return@forEach
            readSet(ctx, dt, start, end).forEach { sp ->
                val t = sampleTime(sp)
                val v = numberFrom(sp, fieldNames) ?: return@forEach
                if (t in start until end) out.add(t to v)
            }
        }
        return out.sortedBy { it.first }
    }

    private fun sumNumeric(
        ctx: Context,
        typeName: String,
        fieldNames: List<String>,
        range: Pair<Long, Long>
    ): Double? {
        val samples = numericSamples(ctx, listOf(typeName), fieldNames, range.first, range.second)
        if (samples.isEmpty()) return null
        return samples.sumOf { it.second }
    }

    private fun dailySum(
        ctx: Context,
        typeName: String,
        fieldNames: List<String>,
        startDay: Int,
        endDay: Int
    ): Double? {
        val dt = dataType(typeName) ?: return null
        val controller = runCatching { HuaweiHiHealth.getDataController(ctx) }.getOrNull() ?: return null
        val set = await(controller.readDailySummation(dt, startDay, endDay)) ?: return null
        var sum = 0.0
        var any = false
        set.samplePoints.forEach { sp ->
            val v = numberFrom(sp, fieldNames) ?: return@forEach
            sum += v
            any = true
        }
        return if (any) sum else null
    }

    private fun sleepPoints(ctx: Context, start: Long, end: Long): List<SleepBit> {
        val dt = dataType("DT_CONTINUOUS_SLEEP") ?: dataType("DT_SLEEP") ?: return emptyList()
        val bits = ArrayList<SleepBit>()
        readSet(ctx, dt, start, end).forEach { sp ->
            val a = sp.getStartTime(TimeUnit.MILLISECONDS)
            val b = sp.getEndTime(TimeUnit.MILLISECONDS).let { if (it <= a) a + 60_000 else it }
            val state = intFrom(sp, listOf("FIELD_SLEEP_STATE", "SLEEP_STATE")) ?: 1
            bits.add(SleepBit(a, b, state != 4))
        }
        return bits.sortedBy { it.start }
    }

    private fun clusterSleep(bits: List<SleepBit>): JSArray {
        val out = JSArray()
        if (bits.isEmpty()) return out
        var start = bits[0].start
        var end = bits[0].end
        var asleep = if (bits[0].asleep) bits[0].end - bits[0].start else 0L
        fun flush() {
            if (end > start) {
                val o = JSObject().put("start", start).put("end", end)
                if (asleep > 0) o.put("asleepMin", (asleep / 60_000L).toInt())
                out.put(o)
            }
        }
        for (i in 1 until bits.size) {
            val b = bits[i]
            if (b.start - end > 90 * 60_000L) {
                flush()
                start = b.start
                end = b.end
                asleep = if (b.asleep) b.end - b.start else 0L
            } else {
                if (b.end > end) end = b.end
                if (b.asleep) asleep += b.end - b.start
            }
        }
        flush()
        return out
    }

    private data class SleepBit(val start: Long, val end: Long, val asleep: Boolean)

    private fun readSet(ctx: Context, dt: DataType, start: Long, end: Long): List<SamplePoint> {
        val controller = HuaweiHiHealth.getDataController(ctx)
        val options = ReadOptions.Builder()
            .read(dt)
            .setTimeRange(start, end, TimeUnit.MILLISECONDS)
            .build()
        val reply = await(controller.read(options)) ?: return emptyList()
        val out = ArrayList<SamplePoint>()
        reply.sampleSets.orEmpty().forEach { set -> out.addAll(set.samplePoints) }
        return out
    }

    private fun sampleTime(sp: SamplePoint): Long {
        val sampling = runCatching { sp.getSamplingTime(TimeUnit.MILLISECONDS) }.getOrNull() ?: 0L
        if (sampling > 0) return sampling
        return sp.getStartTime(TimeUnit.MILLISECONDS)
    }

    private fun numberFrom(sp: SamplePoint, fieldNames: List<String>): Double? {
        fieldNames.forEach { name ->
            val f = field(name) ?: return@forEach
            val v = runCatching { sp.getFieldValue(f) }.getOrNull() ?: return@forEach
            numberOf(v)?.let { return it }
        }
        sp.dataType.fields.orEmpty().forEach { f ->
            val v = runCatching { sp.getFieldValue(f) }.getOrNull() ?: return@forEach
            numberOf(v)?.let { return it }
        }
        return null
    }

    private fun intFrom(sp: SamplePoint, fieldNames: List<String>): Int? =
        numberFrom(sp, fieldNames)?.toInt()

    private fun numberOf(v: Any): Double? {
        runCatching { v.javaClass.getMethod("asFloatValue").invoke(v) as Float }.getOrNull()
            ?.let { return it.toDouble() }
        runCatching { v.javaClass.getMethod("asDoubleValue").invoke(v) as Double }.getOrNull()
            ?.let { return it }
        runCatching { v.javaClass.getMethod("asIntValue").invoke(v) as Int }.getOrNull()
            ?.let { return it.toDouble() }
        runCatching { v.javaClass.getMethod("asLongValue").invoke(v) as Long }.getOrNull()
            ?.let { return it.toDouble() }
        return when (v) {
            is Number -> v.toDouble()
            else -> v.toString().toDoubleOrNull()
        }
    }

    private fun caloriesOf(rec: ActivityRecord): Double {
        val summary = rec.activitySummary ?: return 0.0
        summary.dataSummary.orEmpty().forEach { sp ->
            val v = numberFrom(sp, listOf("FIELD_CALORIES", "FIELD_CALORIES_TOTAL", "FIELD_AVG"))
            if (v != null && v > 0) return v
        }
        return 0.0
    }

    private fun exerciseName(type: String?): String {
        val s = (type ?: "").lowercase(Locale.US)
        return when {
            s.contains("run") -> "running"
            s.contains("walk") -> "walking"
            s.contains("cycl") || s.contains("bike") || s.contains("bik") -> "cycling"
            s.contains("swim") -> "swimming"
            s.contains("hik") -> "hiking"
            s.contains("strength") || s.contains("weight") -> "strength"
            else -> "workout"
        }
    }

    private fun healthAppAuthorized(ctx: Context): Boolean {
        val setting = runCatching { HuaweiHiHealth.getSettingController(ctx) }.getOrNull() ?: return false
        val task = runCatching {
            setting.javaClass.methods.firstOrNull {
                it.name == "getHealthAppAuthorization" && it.parameterCount == 0
            }?.invoke(setting) as? Task<*>
        }.getOrNull() ?: return savedGranted(ctx).isNotEmpty()
        return await(task, 8_000) == true
    }

    private fun requestedScopes(): Array<String> {
        val names = listOf(
            "HEALTHKIT_STEP_READ",
            "HEALTHKIT_CALORIES_READ",
            "HEALTHKIT_HEARTRATE_READ",
            "HEALTHKIT_SLEEP_READ",
            "HEALTHKIT_ACTIVITY_RECORD_READ",
            "HEALTHKIT_OXYGENSATURATION_READ",
            "HEALTHKIT_OXYGEN_SATURATION_READ",
            "HEALTHKIT_HEARTHEALTH_READ"
        )
        return names.mapNotNull { scope(it) }.distinct().toTypedArray()
    }

    private fun scopeNames(): List<String> = listOf(
        "READ_HEART_RATE", "READ_RESTING_HEART_RATE", "READ_SLEEP", "READ_STEPS",
        "READ_ACTIVE_CALORIES_BURNED", "READ_TOTAL_CALORIES_BURNED", "READ_EXERCISE",
        "READ_OXYGEN_SATURATION", "READ_HEART_RATE_VARIABILITY"
    )

    private fun grantedResult(held: List<String>): JSObject {
        val granted = JSArray()
        held.forEach { granted.put(it) }
        return JSObject().put("granted", granted).put("historyAccessAuthorized", held.isNotEmpty())
            .put("provider", "huawei")
    }

    private fun saveGranted(ctx: Context, names: List<String>) {
        ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .edit().putString(PREF_GRANTED, names.joinToString(",")).apply()
    }

    private fun savedGranted(ctx: Context): List<String> {
        val raw = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
            .getString(PREF_GRANTED, "") ?: return emptyList()
        if (raw.isBlank()) return emptyList()
        return raw.split(',').filter { it.isNotBlank() }
    }

    private fun yyyymmdd(ms: Long): Int =
        SimpleDateFormat("yyyyMMdd", Locale.US).format(Date(ms)).toInt()

    private fun packageInstalled(ctx: Context, pkg: String): Boolean =
        runCatching { ctx.packageManager.getPackageInfo(pkg, 0); true }.getOrDefault(false)

    private fun scope(name: String): String? =
        runCatching { Scopes::class.java.getField(name).get(null) as String }.getOrNull()

    private fun dataType(name: String): DataType? {
        runCatching { DataType::class.java.getField(name).get(null) as DataType }.getOrNull()?.let { return it }
        return runCatching {
            Class.forName("com.huawei.hms.hihealth.data.HealthDataTypes")
                .getField(name).get(null) as DataType
        }.getOrNull()
    }

    private fun field(name: String): Field? =
        runCatching { Field::class.java.getField(name).get(null) as Field }.getOrNull()

    @Suppress("UNCHECKED_CAST")
    private fun <T> await(task: Task<T>?, ms: Long = AWAIT_MS): T? {
        if (task == null) return null
        return try {
            Tasks.await(task, ms, TimeUnit.MILLISECONDS)
        } catch (e: Throwable) {
            if (isAuthError(e)) throw e
            null
        }
    }
}
