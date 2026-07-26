package com.codexmonitor.mobile

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.net.URI
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@Serializable
data class UpdateMigration(
    val v: Int = 2,
    val wsUrl: String? = null,
    val lanWsUrl: String? = null,
    val lanHostWsUrl: String? = null,
    val relayWsUrl: String? = null,
)

@Serializable
data class UpdateManifest(
    val versionCode: Int,
    val versionName: String,
    val size: Long,
    val sha256: String,
    val downloadPath: String,
    val migration: UpdateMigration? = null,
)

data class UpdateOffer(
    val pairing: PairingData,
    val manifest: UpdateManifest,
    val baseUrl: String,
    val migrationOnly: Boolean = false,
)

object UpdateCheckPolicy {
    const val FOREGROUND_INTERVAL_MS = 60_000L

    fun shouldCheck(lastCheckAt: Long, now: Long): Boolean =
        lastCheckAt <= 0L || now < lastCheckAt || now - lastCheckAt >= FOREGROUND_INTERVAL_MS
}

object UpdateReminderPolicy {
    const val INTERVAL_MS = 60_000L

    fun isDue(hasOffer: Boolean, appVisible: Boolean, lastReminderAt: Long, now: Long): Boolean =
        hasOffer && !appVisible && (lastReminderAt == 0L || now - lastReminderAt >= INTERVAL_MS)
}

object UpdateEndpointPolicy {
    fun baseUrls(pairing: PairingData): List<String> {
        val direct = pairing.endpoints(ConnectionPreference.DIRECT).flatMap { endpoint ->
            listOfNotNull(externalFeedBaseUrl(endpoint.wsUrl), httpBaseUrl(endpoint.wsUrl))
        }
        val secureLegacy = pairing.wsUrl.takeIf { it.startsWith("wss://") }?.let(::httpBaseUrl)
        return (direct + listOfNotNull(secureLegacy)).distinct()
    }

    private fun externalFeedBaseUrl(wsUrl: String): String? {
        val uri = URI(wsUrl)
        if (!uri.scheme.equals("ws", ignoreCase = true) || uri.host.isNullOrBlank()) return null
        val host = uri.host.let { if (it.contains(':')) "[$it]" else it }
        return "http://$host:43118"
    }

    private fun httpBaseUrl(wsUrl: String): String {
        val uri = URI(wsUrl)
        val scheme = if (uri.scheme == "wss") "https" else "http"
        return "$scheme://${uri.rawAuthority}"
    }
}

object AppUpdater {
    private val json = Json { ignoreUnknownKeys = true }
    private val executor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    fun check(context: Context, pairings: List<PairingData>, callback: (Result<UpdateOffer?>) -> Unit) {
        val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
        val currentVersionCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            packageInfo.longVersionCode
        } else {
            @Suppress("DEPRECATION")
            packageInfo.versionCode.toLong()
        }
        executor.execute {
            var lastError: Throwable? = null
            var newest: UpdateOffer? = null
            var successfulChecks = 0
            for (pairing in pairings) {
                for (baseUrl in UpdateEndpointPolicy.baseUrls(pairing)) {
                    try {
                        val url = "$baseUrl/android/latest.json".toHttpUrl().newBuilder()
                            .addQueryParameter("token", pairing.token)
                            .build()
                        client.newCall(Request.Builder().url(url).build()).execute().use { response ->
                            if (!response.isSuccessful) error("${pairing.name} 未提供更新 (${response.code})")
                            val manifest = json.decodeFromString<UpdateManifest>(response.body?.string() ?: error("更新信息为空"))
                            successfulChecks += 1
                            val migratedPairing = pairing.withMigration(manifest.migration)
                            val migrationOnly = migratedPairing != pairing && manifest.versionCode.toLong() <= currentVersionCode
                            if ((manifest.versionCode.toLong() > currentVersionCode || migrationOnly) &&
                                (newest == null || manifest.versionCode > newest.manifest.versionCode ||
                                    (manifest.versionCode == newest.manifest.versionCode && newest.migrationOnly && !migrationOnly))
                            ) {
                                newest = UpdateOffer(migratedPairing, manifest, baseUrl, migrationOnly)
                            }
                        }
                        break
                    } catch (error: Throwable) {
                        lastError = error
                    }
                }
            }
            val result = if (newest != null || successfulChecks > 0 || lastError == null) {
                Result.success(newest)
            } else {
                Result.failure(lastError)
            }
            main.post { callback(result) }
        }
    }

    fun download(context: Context, offer: UpdateOffer, callback: (Result<File>) -> Unit) {
        executor.execute {
            val result = runCatching {
                val url = (offer.baseUrl + offer.manifest.downloadPath).toHttpUrl().newBuilder()
                    .addQueryParameter("token", offer.pairing.token)
                    .build()
                val target = File(context.cacheDir, "updates/Codex-Monitor-${offer.manifest.versionName}.apk")
                target.parentFile?.mkdirs()
                val digest = MessageDigest.getInstance("SHA-256")
                client.newCall(Request.Builder().url(url).build()).execute().use { response ->
                    if (!response.isSuccessful) error("下载失败 (${response.code})")
                    val body = response.body ?: error("安装包为空")
                    target.outputStream().use { output ->
                        body.byteStream().use { input ->
                            val buffer = ByteArray(64 * 1024)
                            while (true) {
                                val count = input.read(buffer)
                                if (count < 0) break
                                output.write(buffer, 0, count)
                                digest.update(buffer, 0, count)
                            }
                        }
                    }
                }
                require(target.length() == offer.manifest.size) { "安装包大小校验失败" }
                val actualSha256 = digest.digest().joinToString("") { "%02x".format(it) }
                require(actualSha256.equals(offer.manifest.sha256, ignoreCase = true)) { "安装包安全校验失败" }
                target
            }
            main.post { callback(result) }
        }
    }

}
