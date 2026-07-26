package com.codexmonitor.mobile

import java.net.URI
import kotlinx.serialization.Serializable

@Serializable
data class PairingData(
    val v: Int,
    val id: String,
    val name: String,
    val wsUrl: String,
    val token: String,
    val lanWsUrl: String? = null,
    val lanHostWsUrl: String? = null,
    val relayWsUrl: String? = null,
) {
    fun endpoints(preference: ConnectionPreference): List<ConnectionEndpoint> {
        val legacyHostFallback = legacyHostEndpoint()
        val direct = listOfNotNull(
            lanWsUrl,
            wsUrl.takeIf { it.startsWith("ws://") },
            lanHostWsUrl,
            legacyHostFallback,
        ).map { ConnectionEndpoint(ConnectionPreference.DIRECT, it) }
        val relay = (relayWsUrl ?: wsUrl.takeIf { it.startsWith("wss://") })
            ?.let { ConnectionEndpoint(ConnectionPreference.RELAY, it) }
        val candidates = when (preference) {
            ConnectionPreference.AUTOMATIC -> direct + listOfNotNull(relay)
            ConnectionPreference.DIRECT -> direct
            ConnectionPreference.RELAY -> listOfNotNull(relay).ifEmpty { direct }
        }
        return candidates.distinctBy { it.wsUrl }
    }

    fun hasRelay(): Boolean =
        relayWsUrl?.startsWith("wss://") == true || wsUrl.startsWith("wss://")

    fun withMigration(migration: UpdateMigration?): PairingData {
        if (migration == null) return this
        val migratedLan = migration.lanWsUrl ?: migration.wsUrl
        val migratedWs = migration.wsUrl ?: migratedLan ?: wsUrl
        return copy(
            v = maxOf(v, 2),
            wsUrl = migratedWs,
            lanWsUrl = migratedLan ?: lanWsUrl,
            lanHostWsUrl = migration.lanHostWsUrl ?: lanHostWsUrl,
            relayWsUrl = migration.relayWsUrl ?: relayWsUrl,
        )
    }

    private fun legacyHostEndpoint(): String? {
        val host = name.trim().removeSuffix(".")
        if (!host.endsWith(".local", ignoreCase = true) ||
            !host.matches(Regex("[A-Za-z0-9][A-Za-z0-9.-]*\\.local", RegexOption.IGNORE_CASE))
        ) return null
        val source = runCatching { URI(wsUrl) }.getOrNull() ?: return null
        if (!source.scheme.equals("ws", ignoreCase = true) || source.host.isNullOrBlank()) return null
        val port = source.port.takeIf { it > 0 } ?: 43117
        val path = source.rawPath.takeIf { it.isNullOrBlank().not() } ?: "/monitor"
        return "ws://$host:$port$path"
    }
}

enum class ConnectionPreference(val label: String) {
    AUTOMATIC("自动"),
    DIRECT("局域网"),
    RELAY("远程中继"),
}

data class ConnectionEndpoint(val preference: ConnectionPreference, val wsUrl: String)

object ConnectionPreferencePolicy {
    fun resolve(pairing: PairingData, preference: ConnectionPreference): ConnectionPreference =
        if (preference == ConnectionPreference.RELAY && !pairing.hasRelay()) {
            ConnectionPreference.AUTOMATIC
        } else {
            preference
        }
}

object ResponseValidationPolicy {
    fun guidanceMatches(expectedSessionId: String, responseSessionId: String): Boolean =
        expectedSessionId == responseSessionId

    fun goalMatches(
        expectedSessionId: String,
        responseSessionId: String,
        expectedCommand: String,
        responseCommand: String,
    ): Boolean = responseSessionId == expectedSessionId &&
        (responseCommand.isEmpty() || responseCommand == expectedCommand)
}

object SessionStateRestorePolicy {
    fun previousState(liveState: String?, cachedState: String?, persistedState: String?): String? =
        liveState ?: cachedState ?: persistedState
}

@Serializable
data class GoalInfo(
    val status: String,
    val objective: String = "",
)

object GoalPresentation {
    fun label(status: String): String = when (status) {
        "active" -> "进行中"
        "paused" -> "已暂停"
        "blocked" -> "已阻塞"
        "usageLimited" -> "用量受限"
        "budgetLimited" -> "预算受限"
        "complete" -> "已完成"
        else -> status
    }

    fun canResume(status: String, sessionRunning: Boolean): Boolean =
        status == "paused" ||
            (!sessionRunning && status in setOf("active", "blocked", "usageLimited", "budgetLimited"))
}

@Serializable
data class EvidenceImage(
    val id: String,
    val name: String,
    val mimeType: String,
    val downloadPath: String,
)

@Serializable
data class SessionStatus(
    val id: String,
    val title: String,
    val updatedAt: String,
    val state: String,
    val message: String,
    val goal: GoalInfo? = null,
    val evidence: List<EvidenceImage> = emptyList(),
)

@Serializable
data class MachineInfo(val id: String, val name: String)

@Serializable
data class WireSnapshot(
    val type: String,
    val machine: MachineInfo,
    val sentAt: String,
    val sessions: List<SessionStatus>,
)

@Serializable
data class PushRegistrationMessage(
    val type: String = "push_registration",
    val platform: String = "android",
    val pushToken: String,
    val enabled: Boolean,
    val silentCompletionSessionIds: List<String> = emptyList(),
)

@Serializable
data class PushReadMessage(
    val type: String = "push_read",
    val platform: String = "android",
    val pushToken: String,
    val sessionId: String,
    val state: String,
)

data class LampPushEvent(
    val deviceId: String,
    val deviceName: String,
    val sessionId: String,
    val sessionTitle: String,
    val fromState: String,
    val toState: String,
    val silent: Boolean,
    val reminder: Boolean,
) {
    companion object {
        private val states = setOf("running", "blocked", "completed", "unknown")

        fun from(data: Map<String, String>): LampPushEvent? {
            if (data["type"] != "lamp_changed") return null
            val deviceId = data["deviceId"].orEmpty()
            val sessionId = data["sessionId"].orEmpty()
            val fromState = data["fromState"].orEmpty()
            val toState = data["toState"].orEmpty()
            if (deviceId.isBlank() || sessionId.isBlank() || fromState !in states || toState !in states || fromState == toState) return null
            return LampPushEvent(
                deviceId = deviceId,
                deviceName = data["deviceName"].orEmpty().ifBlank { "电脑" },
                sessionId = sessionId,
                sessionTitle = data["sessionTitle"].orEmpty().ifBlank { "Codex 会话" },
                fromState = fromState,
                toState = toState,
                silent = data["silent"]?.toBooleanStrictOrNull() ?: false,
                reminder = data["reminder"]?.toBooleanStrictOrNull() ?: false,
            )
        }
    }
}

@Serializable
data class GuidanceAttachment(
    val name: String,
    val mimeType: String,
    val sizeBytes: Int,
    val dataBase64: String,
)

@Serializable
data class GuidanceMessage(
    val type: String = "guidance",
    val requestId: String,
    val sessionId: String,
    val text: String,
    val mode: String,
    val attachments: List<GuidanceAttachment> = emptyList(),
)

@Serializable
data class GuidanceResult(
    val type: String,
    val requestId: String,
    val sessionId: String,
    val ok: Boolean,
    val message: String,
)

@Serializable
data class GuidanceAck(
    val type: String,
    val requestId: String,
    val sessionId: String,
    val message: String,
)

@Serializable
data class GoalCommandMessage(
    val type: String = "goal_command",
    val requestId: String,
    val sessionId: String,
    val command: String,
    val confirmed: Boolean = false,
)

@Serializable
data class GoalCommandAck(
    val type: String,
    val requestId: String,
    val sessionId: String,
    val message: String,
)

@Serializable
data class GoalCommandResult(
    val type: String,
    val requestId: String,
    val sessionId: String,
    val command: String = "",
    val ok: Boolean,
    val message: String,
)

data class GuidanceUi(val sending: Boolean, val ok: Boolean?, val message: String)
data class GoalCommandUi(val sending: Boolean, val ok: Boolean?, val message: String)

@Serializable
data class LastSentGuidance(
    val deviceId: String,
    val sessionId: String,
    val text: String,
)

data class DeviceUi(
    val pairing: PairingData,
    val connected: Boolean = false,
    val lastSeenMs: Long? = null,
    val sessions: List<SessionStatus> = emptyList(),
    val newSessionIds: Set<String> = emptySet(),
)
