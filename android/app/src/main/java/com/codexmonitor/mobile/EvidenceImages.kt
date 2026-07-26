package com.codexmonitor.mobile

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.URI
import java.util.concurrent.TimeUnit

object EvidenceImages {
    private const val MAX_BYTES = 20 * 1024 * 1024
    private val client = OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(12, TimeUnit.SECONDS)
        .callTimeout(15, TimeUnit.SECONDS)
        .build()

    suspend fun load(pairing: PairingData, evidence: EvidenceImage): Bitmap = withContext(Dispatchers.IO) {
        require(evidence.downloadPath.matches(Regex("^/evidence/[a-f0-9]{32}$"))) { "证据图片地址无效" }
        var lastError: Throwable? = null
        for (baseUrl in EvidenceEndpointPolicy.baseUrls(
            pairing,
            MonitorStore.connectionPreference(pairing.id),
        )) {
            try {
                val url = (baseUrl + evidence.downloadPath).toHttpUrl().newBuilder()
                    .addQueryParameter("token", pairing.token)
                    .build()
                val bytes = client.newCall(Request.Builder().url(url).build()).execute().use { response ->
                    require(response.isSuccessful) { "图片下载失败 (${response.code})" }
                    require(response.header("Content-Type")?.substringBefore(';') == evidence.mimeType) { "图片类型校验失败" }
                    val body = requireNotNull(response.body) { "图片内容为空" }
                    require(body.contentLength() in -1..MAX_BYTES.toLong()) { "图片过大" }
                    body.bytes().also { require(it.size <= MAX_BYTES) { "图片过大" } }
                }
                return@withContext requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size)) {
                    "图片格式无效"
                }
            } catch (error: Throwable) {
                lastError = error
            }
        }
        throw IllegalArgumentException(lastError?.message ?: "没有可用的图片下载地址")
    }
}

object EvidenceEndpointPolicy {
    private val relayPath = Regex("^(.*?)/relay/(?:phone|device)/[^/]+/?$")

    fun baseUrls(
        pairing: PairingData,
        preference: ConnectionPreference = ConnectionPreference.AUTOMATIC,
    ): List<String> = pairing.endpoints(preference).mapNotNull { endpoint ->
        runCatching {
            val uri = URI(endpoint.wsUrl)
            require(uri.scheme.equals("ws", true) || uri.scheme.equals("wss", true))
            require(!uri.rawAuthority.isNullOrBlank())
            val scheme = if (uri.scheme.equals("wss", true)) "https" else "http"
            val path = uri.rawPath.orEmpty()
            val prefix = relayPath.matchEntire(path)?.groupValues?.get(1)
                ?: path.removeSuffix("/monitor")
            "$scheme://${uri.rawAuthority}${prefix.removeSuffix("/")}"
        }.getOrNull()
    }.distinct()
}
