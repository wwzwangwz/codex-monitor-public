package com.codexmonitor.mobile

import kotlinx.serialization.json.Json

internal val ProtocolJson = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
}
