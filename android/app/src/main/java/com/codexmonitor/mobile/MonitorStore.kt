package com.codexmonitor.mobile

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

object MonitorStore {
    private const val PREFS = "codex_monitor"
    private const val KEY_DEVICES = "paired_devices"
    private const val KEY_TEMPLATES = "guidance_templates"
    private const val KEY_MONITORING_ENABLED = "monitoring_enabled"
    private const val KEY_UNREAD = "unread_session_ids"
    private const val KEY_SILENT_UNREAD = "silent_unread_session_keys"
    private const val KEY_JARVIS_SESSIONS = "jarvis_session_keys"
    private const val KEY_CONNECTION_PREFERENCES = "connection_preferences"
    private const val KEY_PUSH_STATES = "push_session_states"
    private const val KEY_LAST_SENT_GUIDANCE = "last_sent_guidance"
    private val defaultTemplates = listOf(
        "继续执行当前任务。",
        "使用 Goal 目标继续执行，在目标完成前持续推进。",
    )
    private val json = Json { ignoreUnknownKeys = true }
    private lateinit var appContext: Context
    private val _devices = MutableStateFlow<List<DeviceUi>>(emptyList())
    val devices: StateFlow<List<DeviceUi>> = _devices.asStateFlow()
    private val _templates = MutableStateFlow(defaultTemplates)
    val templates: StateFlow<List<String>> = _templates.asStateFlow()
    private val _guidanceStatus = MutableStateFlow<Map<String, GuidanceUi>>(emptyMap())
    val guidanceStatus: StateFlow<Map<String, GuidanceUi>> = _guidanceStatus.asStateFlow()
    private val _goalCommandStatus = MutableStateFlow<Map<String, GoalCommandUi>>(emptyMap())
    val goalCommandStatus: StateFlow<Map<String, GoalCommandUi>> = _goalCommandStatus.asStateFlow()
    private val _monitoringEnabled = MutableStateFlow(true)
    val monitoringEnabled: StateFlow<Boolean> = _monitoringEnabled.asStateFlow()
    private val _backgroundDiagnostic = MutableStateFlow<String?>(null)
    val backgroundDiagnostic: StateFlow<String?> = _backgroundDiagnostic.asStateFlow()
    private val _jarvisSessionKeys = MutableStateFlow<Set<String>>(emptySet())
    val jarvisSessionKeys: StateFlow<Set<String>> = _jarvisSessionKeys.asStateFlow()
    private val _silentUnreadSessionKeys = MutableStateFlow<Set<String>>(emptySet())
    private val _connectionPreferences = MutableStateFlow<Map<String, ConnectionPreference>>(emptyMap())
    val connectionPreferences: StateFlow<Map<String, ConnectionPreference>> = _connectionPreferences.asStateFlow()
    private val pendingGuidance = mutableMapOf<String, GuidanceMessage>()
    private var lastSentGuidance: LastSentGuidance? = null

    fun initialize(context: Context) {
        if (::appContext.isInitialized) return
        appContext = context.applicationContext
        val preferences = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        _monitoringEnabled.value = preferences.getBoolean(KEY_MONITORING_ENABLED, true)
        val raw = preferences.getString(KEY_DEVICES, null)
        val storedPairings = runCatching {
            raw?.let { json.decodeFromString(ListSerializer(PairingData.serializer()), it) }
        }.getOrNull().orEmpty()
        val pairings = storedPairings
        val unreadRaw = preferences.getString(KEY_UNREAD, null)
        val unread = runCatching {
            unreadRaw?.let {
                json.decodeFromString(
                    MapSerializer(String.serializer(), ListSerializer(String.serializer())),
                    it,
                )
            }
        }.getOrNull().orEmpty()
        _devices.value = pairings.map { pairing ->
            DeviceUi(pairing, newSessionIds = unread[pairing.id].orEmpty().toSet())
        }
        _jarvisSessionKeys.value = preferences.getStringSet(KEY_JARVIS_SESSIONS, emptySet()).orEmpty().toSet()
        _silentUnreadSessionKeys.value = preferences.getStringSet(KEY_SILENT_UNREAD, emptySet()).orEmpty().toSet()
        val storedConnectionPreferences = runCatching {
            preferences.getString(KEY_CONNECTION_PREFERENCES, null)?.let {
                json.decodeFromString(MapSerializer(String.serializer(), String.serializer()), it)
                    .mapValues { (_, value) -> ConnectionPreference.valueOf(value) }
            }
        }.getOrNull().orEmpty()
        val pairingsById = pairings.associateBy(PairingData::id)
        _connectionPreferences.value = storedConnectionPreferences.mapValues { (id, preference) ->
            pairingsById[id]?.let { ConnectionPreferencePolicy.resolve(it, preference) }
                ?: preference
        }
        if (_connectionPreferences.value != storedConnectionPreferences) {
            persistConnectionPreferences()
        }
        val templatesRaw = preferences.getString(KEY_TEMPLATES, null)
        _templates.value = runCatching {
            templatesRaw?.let { json.decodeFromString(ListSerializer(String.serializer()), it) }
        }.getOrNull()?.filter { it.isNotBlank() }?.take(8).orEmpty().ifEmpty { defaultTemplates }
        lastSentGuidance = runCatching {
            preferences.getString(KEY_LAST_SENT_GUIDANCE, null)?.let {
                json.decodeFromString(LastSentGuidance.serializer(), it)
            }
        }.getOrNull()
    }

    fun pairFromQr(value: String): PairingData {
        val pairing = PairingCodec.parse(value)
        val previous = _devices.value.firstOrNull { it.pairing.id == pairing.id }
        _devices.value = _devices.value.filterNot { it.pairing.id == pairing.id } + DeviceUi(
            pairing = pairing,
            sessions = previous?.sessions.orEmpty(),
            newSessionIds = previous?.newSessionIds.orEmpty(),
        )
        _connectionPreferences.value[pairing.id]?.let { preference ->
            val resolved = ConnectionPreferencePolicy.resolve(pairing, preference)
            if (resolved != preference) {
                _connectionPreferences.value = _connectionPreferences.value + (pairing.id to resolved)
                persistConnectionPreferences()
            }
        }
        persist()
        return pairing
    }

    fun remove(id: String) {
        _devices.value = _devices.value.filterNot { it.pairing.id == id }
        _connectionPreferences.value = _connectionPreferences.value - id
        persist()
        persistUnread()
        persistConnectionPreferences()
    }

    fun pairings(): List<PairingData> = _devices.value.map { it.pairing }

    fun pairing(id: String): PairingData? = _devices.value.firstOrNull { it.pairing.id == id }?.pairing

    fun replacePairing(pairing: PairingData): Boolean {
        var changed = false
        _devices.value = _devices.value.map {
            if (it.pairing.id == pairing.id && it.pairing != pairing) {
                changed = true
                it.copy(pairing = pairing)
            } else it
        }
        if (changed) persist()
        return changed
    }

    fun isPaired(id: String): Boolean = _devices.value.any { it.pairing.id == id }

    fun connectionPreference(id: String): ConnectionPreference {
        val preference = _connectionPreferences.value[id] ?: ConnectionPreference.AUTOMATIC
        val pairing = pairing(id) ?: return preference
        return ConnectionPreferencePolicy.resolve(pairing, preference)
    }

    fun setConnectionPreference(id: String, preference: ConnectionPreference) {
        val pairing = pairing(id) ?: return
        _connectionPreferences.value = _connectionPreferences.value +
            (id to ConnectionPreferencePolicy.resolve(pairing, preference))
        persistConnectionPreferences()
    }

    fun setMonitoringEnabled(enabled: Boolean) {
        _monitoringEnabled.value = enabled
        appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean(KEY_MONITORING_ENABLED, enabled)
            .apply()
        if (!enabled) {
            _devices.value = _devices.value.map { it.copy(connected = false) }
            _guidanceStatus.value = emptyMap()
            _goalCommandStatus.value = emptyMap()
            _backgroundDiagnostic.value = null
        }
    }

    fun setConnected(id: String, connected: Boolean) {
        _devices.value = _devices.value.map {
            if (it.pairing.id == id) it.copy(connected = connected) else it
        }
    }

    fun persistedSessionStates(deviceId: String): Map<String, String> {
        if (!::appContext.isInitialized) return emptyMap()
        val prefix = "$deviceId:"
        return appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getStringSet(KEY_PUSH_STATES, emptySet())
            .orEmpty()
            .mapNotNull { encoded ->
                if (!encoded.startsWith(prefix)) return@mapNotNull null
                val sessionId = encoded.removePrefix(prefix).substringBefore('=')
                val state = encoded.substringAfter('=', missingDelimiterValue = "")
                if (sessionId.isBlank() || state.isBlank()) null else sessionId to state
            }
            .toMap()
    }

    fun applySnapshot(id: String, sessions: List<SessionStatus>, seenAt: Long) {
        val previousStates = _devices.value.firstOrNull { it.pairing.id == id }
            ?.sessions.orEmpty().associate { it.id to it.state }
        val persistedStates = persistedSessionStates(id)
        val changed = sessions.mapNotNull { session ->
            val oldState = SessionStateRestorePolicy.previousState(
                liveState = null,
                cachedState = previousStates[session.id],
                persistedState = persistedStates[session.id],
            )
            session.id.takeIf { oldState != null && oldState != session.state }
        }
        _devices.value = _devices.value.map {
            if (it.pairing.id == id) {
                it.copy(
                    connected = true,
                    sessions = sessions,
                    lastSeenMs = seenAt,
                    newSessionIds = (it.newSessionIds + changed).intersect(sessions.map { session -> session.id }.toSet()),
                )
            } else it
        }
        val changedKeys = changed.map { sessionKey(id, it) }.toSet()
        if (changedKeys.isNotEmpty()) {
            _silentUnreadSessionKeys.value = _silentUnreadSessionKeys.value - changedKeys
            persistSilentUnread()
        }
        persistUnread()
        persistPushStates(id, sessions.associate { it.id to it.state })
    }

    fun clearNew(deviceId: String, sessionId: String) {
        _devices.value.firstOrNull { it.pairing.id == deviceId }?.let { device ->
            device.sessions.firstOrNull { it.id == sessionId }?.state?.let { state ->
                PushRegistrationManager.acknowledgeRead(appContext, device.pairing, sessionId, state)
            }
        }
        _devices.value = _devices.value.map {
            if (it.pairing.id == deviceId) it.copy(newSessionIds = it.newSessionIds - sessionId) else it
        }
        _silentUnreadSessionKeys.value = _silentUnreadSessionKeys.value - sessionKey(deviceId, sessionId)
        persistSilentUnread()
        persistUnread()
    }

    fun markSilentUnread(deviceId: String, sessionId: String) {
        _silentUnreadSessionKeys.value = _silentUnreadSessionKeys.value + sessionKey(deviceId, sessionId)
        persistSilentUnread()
    }

    fun audibleUnreadCount(): Int = _devices.value.sumOf { device ->
        device.newSessionIds.count { sessionId -> sessionKey(device.pairing.id, sessionId) !in _silentUnreadSessionKeys.value }
    }

    fun isJarvisSession(deviceId: String, sessionId: String): Boolean =
        sessionKey(deviceId, sessionId) in _jarvisSessionKeys.value

    fun setJarvisSession(deviceId: String, sessionId: String, enabled: Boolean) {
        val key = sessionKey(deviceId, sessionId)
        _jarvisSessionKeys.value = if (enabled) _jarvisSessionKeys.value + key else _jarvisSessionKeys.value - key
        appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putStringSet(KEY_JARVIS_SESSIONS, _jarvisSessionKeys.value)
            .apply()
    }

    fun jarvisSessionIds(deviceId: String): List<String> = _jarvisSessionKeys.value.mapNotNull { key ->
        key.removePrefix("$deviceId:").takeIf { key.startsWith("$deviceId:") }
    }

    fun applyPushTransition(event: LampPushEvent): Boolean {
        if (!_monitoringEnabled.value || !isPaired(event.deviceId)) return false
        val device = _devices.value.firstOrNull { it.pairing.id == event.deviceId } ?: return false
        val current = device.sessions.firstOrNull { it.id == event.sessionId }
        val key = sessionKey(event.deviceId, event.sessionId)
        val persisted = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getStringSet(KEY_PUSH_STATES, emptySet()).orEmpty()
            .firstOrNull { it.startsWith("$key=") }
            ?.substringAfter('=')
        if ((current?.state ?: persisted) == event.toState) return false
        _devices.value = _devices.value.map {
            if (it.pairing.id != event.deviceId) it else it.copy(
                sessions = it.sessions.map { session ->
                    if (session.id == event.sessionId) session.copy(state = event.toState) else session
                },
                newSessionIds = it.newSessionIds + event.sessionId,
            )
        }
        _silentUnreadSessionKeys.value = if (event.silent) {
            _silentUnreadSessionKeys.value + key
        } else {
            _silentUnreadSessionKeys.value - key
        }
        persistSilentUnread()
        persistUnread()
        persistPushStates(event.deviceId, mapOf(event.sessionId to event.toState))
        return true
    }

    fun isUnread(deviceId: String, sessionId: String): Boolean = _devices.value
        .firstOrNull { it.pairing.id == deviceId }
        ?.newSessionIds
        ?.contains(sessionId) == true

    private fun persistPushStates(deviceId: String, states: Map<String, String>) {
        val preferences = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val previous = preferences.getStringSet(KEY_PUSH_STATES, emptySet()).orEmpty()
            .filterNot { value -> states.keys.any { value.startsWith("${sessionKey(deviceId, it)}=") } }
            .toMutableSet()
        previous += states.map { (sessionId, state) -> "${sessionKey(deviceId, sessionId)}=$state" }
        preferences.edit().putStringSet(KEY_PUSH_STATES, previous).apply()
    }

    fun saveTemplates(values: List<String>) {
        _templates.value = values.map(String::trim).filter(String::isNotBlank).distinct().take(8).ifEmpty { defaultTemplates }
        val raw = json.encodeToString(ListSerializer(String.serializer()), _templates.value)
        appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_TEMPLATES, raw).apply()
    }

    fun setGuidanceStatus(deviceId: String, sessionId: String, value: GuidanceUi) {
        _guidanceStatus.value = _guidanceStatus.value + ("$deviceId:$sessionId" to value)
    }

    fun clearGuidanceStatus(deviceId: String, sessionId: String) {
        _guidanceStatus.value = _guidanceStatus.value - "$deviceId:$sessionId"
    }

    fun setGoalCommandStatus(deviceId: String, sessionId: String, value: GoalCommandUi) {
        _goalCommandStatus.value = _goalCommandStatus.value + ("$deviceId:$sessionId" to value)
    }

    fun clearGoalCommandStatus(deviceId: String, sessionId: String) {
        _goalCommandStatus.value = _goalCommandStatus.value - "$deviceId:$sessionId"
    }

    fun setBackgroundDiagnostic(value: String) {
        _backgroundDiagnostic.value = value
    }

    fun clearBackgroundDiagnostic() {
        _backgroundDiagnostic.value = null
    }

    @Synchronized
    fun queueGuidance(message: GuidanceMessage) {
        pendingGuidance[message.requestId] = message
    }

    @Synchronized
    fun takeGuidance(requestId: String): GuidanceMessage? = pendingGuidance.remove(requestId)

    @Synchronized
    fun rememberLastSentGuidance(deviceId: String, sessionId: String, text: String) {
        val value = text.trim()
        if (value.isEmpty()) return
        val guidance = LastSentGuidance(deviceId, sessionId, value)
        lastSentGuidance = guidance
        appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_LAST_SENT_GUIDANCE, json.encodeToString(LastSentGuidance.serializer(), guidance))
            .apply()
    }

    @Synchronized
    fun lastSentGuidance(deviceId: String, sessionId: String): String? = lastSentGuidance
        ?.takeIf { it.deviceId == deviceId && it.sessionId == sessionId }
        ?.text

    fun updateMachineName(id: String, name: String) {
        var changed = false
        _devices.value = _devices.value.map {
            if (it.pairing.id == id && it.pairing.name != name) {
                changed = true
                it.copy(pairing = it.pairing.copy(name = name))
            } else it
        }
        if (changed) persist()
    }

    private fun persist() {
        val raw = json.encodeToString(ListSerializer(PairingData.serializer()), pairings())
        appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_DEVICES, raw).apply()
    }

    private fun persistUnread() {
        val values = _devices.value.associate { it.pairing.id to it.newSessionIds.toList() }
        val raw = json.encodeToString(
            MapSerializer(String.serializer(), ListSerializer(String.serializer())),
            values,
        )
        appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_UNREAD, raw)
            .apply()
    }

    private fun persistSilentUnread() {
        appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putStringSet(KEY_SILENT_UNREAD, _silentUnreadSessionKeys.value)
            .apply()
    }

    private fun persistConnectionPreferences() {
        val raw = json.encodeToString(
            MapSerializer(String.serializer(), String.serializer()),
            _connectionPreferences.value.mapValues { it.value.name },
        )
        appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_CONNECTION_PREFERENCES, raw)
            .apply()
    }

    private fun sessionKey(deviceId: String, sessionId: String) = "$deviceId:$sessionId"
}
