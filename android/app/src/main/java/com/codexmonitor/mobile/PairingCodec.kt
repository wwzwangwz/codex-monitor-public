package com.codexmonitor.mobile

import java.net.URI
import java.net.URLDecoder
import java.util.Base64
import kotlinx.serialization.json.Json

object PairingCodec {
    private val json = Json { ignoreUnknownKeys = true }

    fun parse(value: String): PairingData {
        val uri = URI(value)
        require(uri.scheme == "codex-monitor" && uri.host == "pair") { "这不是 Codex Monitor 配对码" }
        val encoded = uri.rawQuery.orEmpty().split('&')
            .mapNotNull { part ->
                val pieces = part.split('=', limit = 2)
                if (pieces.size == 2 && URLDecoder.decode(pieces[0], Charsets.UTF_8.name()) == "data") {
                    URLDecoder.decode(pieces[1], Charsets.UTF_8.name())
                } else null
            }
            .firstOrNull()
        requireNotNull(encoded) { "配对码缺少连接信息" }
        val decoded = String(Base64.getUrlDecoder().decode(encoded), Charsets.UTF_8)
        val pairing = json.decodeFromString(PairingData.serializer(), decoded)
        require(pairing.v in 1..2) { "不支持此配对码版本" }
        require(pairing.endpoints(ConnectionPreference.AUTOMATIC).isNotEmpty()) { "连接地址无效" }
        require(pairing.endpoints(ConnectionPreference.AUTOMATIC).all { endpoint ->
            endpoint.wsUrl.startsWith("ws://") || endpoint.wsUrl.startsWith("wss://")
        }) { "连接地址无效" }
        require(pairing.id.isNotBlank() && pairing.token.length >= 16) { "配对信息无效" }
        return pairing
    }
}
