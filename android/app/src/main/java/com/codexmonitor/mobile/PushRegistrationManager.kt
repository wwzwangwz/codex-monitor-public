package com.codexmonitor.mobile

import android.content.Context
import java.net.URI
import kotlinx.serialization.encodeToString
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

object PushRegistrationEndpoint {
    fun url(pairing: PairingData): String? = pushEndpoint(pairing, "register")
}

object PushReadEndpoint {
    fun url(pairing: PairingData): String? = pushEndpoint(pairing, "read")
}

private fun pushEndpoint(pairing: PairingData, action: String): String? {
    val relay = pairing.relayWsUrl ?: pairing.wsUrl.takeIf { it.startsWith("wss://") } ?: return null
    val source = runCatching { URI(relay) }.getOrNull() ?: return null
    if (source.scheme !in setOf("ws", "wss") || source.host.isNullOrBlank()) return null
    val scheme = if (source.scheme == "wss") "https" else "http"
    val relayMarker = "/relay/phone/"
    val markerIndex = source.rawPath.indexOf(relayMarker)
    if (markerIndex < 0) return null
    val prefix = source.rawPath.substring(0, markerIndex).trimEnd('/')
    return URI(
        scheme,
        null,
        source.host,
        source.port,
        "$prefix/push/$action/${pairing.id}",
        "token=${pairing.token}",
        null,
    ).toString()
}

object PushRegistrationManager {
    private const val PREFS = "codex_monitor_push"
    private const val KEY_TOKEN = "fcm_token"
    private val client = OkHttpClient()
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    fun storeTokenAndRegister(context: Context, token: String) {
        if (token.isBlank()) return
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_TOKEN, token).apply()
        registerAll(context, enabled = MonitorStore.monitoringEnabled.value)
    }

    fun registerAll(context: Context, enabled: Boolean = MonitorStore.monitoringEnabled.value) {
        val token = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_TOKEN, null) ?: return
        MonitorStore.pairings().forEach { pairing -> register(pairing, token, enabled) }
    }

    fun unregister(context: Context, pairing: PairingData) {
        val token = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_TOKEN, null) ?: return
        register(pairing, token, enabled = false)
    }

    fun acknowledgeRead(context: Context, pairing: PairingData, sessionId: String, state: String) {
        val token = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_TOKEN, null) ?: return
        val endpoint = PushReadEndpoint.url(pairing) ?: return
        val body = ProtocolJson.encodeToString(
            PushReadMessage(pushToken = token, sessionId = sessionId, state = state),
        ).toRequestBody(jsonType)
        client.newCall(Request.Builder().url(endpoint).post(body).build()).enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, error: java.io.IOException) = Unit
            override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
                response.close()
            }
        })
    }

    private fun register(pairing: PairingData, token: String, enabled: Boolean) {
        val endpoint = PushRegistrationEndpoint.url(pairing) ?: return
        val body = ProtocolJson.encodeToString(
            PushRegistrationMessage(
                pushToken = token,
                enabled = enabled,
                silentCompletionSessionIds = MonitorStore.jarvisSessionIds(pairing.id),
            ),
        ).toRequestBody(jsonType)
        client.newCall(Request.Builder().url(endpoint).post(body).build()).enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, error: java.io.IOException) = Unit
            override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
                response.close()
            }
        })
    }
}
