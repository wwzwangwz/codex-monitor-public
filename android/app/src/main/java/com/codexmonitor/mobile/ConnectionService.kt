package com.codexmonitor.mobile

import android.Manifest
import android.app.NotificationChannel
import android.app.AlarmManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.IOException
import java.net.URI
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

class ConnectionService : Service() {
    companion object {
        const val ACTION_CONNECT = "com.codexmonitor.CONNECT"
        const val ACTION_DISCONNECT = "com.codexmonitor.DISCONNECT"
        const val ACTION_APP_FOREGROUND = "com.codexmonitor.APP_FOREGROUND"
        const val ACTION_APP_BACKGROUND = "com.codexmonitor.APP_BACKGROUND"
        const val ACTION_SEND_GUIDANCE = "com.codexmonitor.SEND_GUIDANCE"
        const val ACTION_SEND_GOAL_COMMAND = "com.codexmonitor.SEND_GOAL_COMMAND"
        const val ACTION_SET_MONITORING = "com.codexmonitor.SET_MONITORING"
        const val ACTION_SET_CONNECTION_PREFERENCE = "com.codexmonitor.SET_CONNECTION_PREFERENCE"
        const val EXTRA_MONITORING_ENABLED = "monitoring_enabled"
        const val EXTRA_CONNECTION_PREFERENCE = "connection_preference"
        const val EXTRA_SESSION_ID = "session_id"
        const val EXTRA_REQUEST_ID = "request_id"
        const val EXTRA_GOAL_COMMAND = "goal_command"
        const val EXTRA_GOAL_CONFIRMED = "goal_confirmed"
        private const val EXTRA_FIRST_ATTEMPT_AT = "first_attempt_at"
        private const val ACTION_KEEP_ALIVE = "com.codexmonitor.KEEP_ALIVE"
        const val EXTRA_DEVICE_ID = "device_id"
        private const val CHANNEL_SERVICE = "monitor_service"
        private const val CHANNEL_EVENTS = "codex_events"
        private const val CHANNEL_JARVIS = "codex_jarvis_quiet"
        private const val CHANNEL_UNREAD = "codex_unread_reminders_v1"
        private const val SERVICE_NOTIFICATION = 41
        private const val UPDATE_NOTIFICATION = 42
        private const val UNREAD_NOTIFICATION = 43
        private const val OFFLINE_CONFIRM_MS = 20_000L
        private const val RECONNECT_DELAY_MS = 2_000L
        private const val UPDATE_CHECK_MS = 5 * 60_000L
        private const val NEW_REMINDER_MS = 60_000L
        private const val HEARTBEAT_MS = 5_000L
        private const val GUIDANCE_RECONNECT_RETRY_MS = 1_000L
        private const val GUIDANCE_RECONNECT_TIMEOUT_MS = 10_000L
        private const val GUIDANCE_RESULT_TIMEOUT_MS = 30_000L
        private const val GOAL_RESULT_TIMEOUT_MS = 30_000L
        private const val HEARTBEAT_PREF = "service_heartbeat_wall_ms"
    }

    private val json = ProtocolJson
    private val client = OkHttpClient.Builder()
        .pingInterval(10, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()
    private val sockets = mutableMapOf<String, WebSocket>()
    private val activeEndpoints = mutableMapOf<String, ConnectionEndpoint>()
    private val endpointIndexes = mutableMapOf<String, Int>()
    private val latestStates = mutableMapOf<String, String>()
    private val notifiedStates = mutableMapOf<String, String>()
    private val pendingNotifications = mutableMapOf<String, Runnable>()
    private val pendingOffline = mutableMapOf<String, Runnable>()
    private val reconnectTasks = mutableMapOf<String, Runnable>()
    private val guidanceTimeouts = mutableMapOf<String, Runnable>()
    private val guidanceInFlight = mutableMapOf<String, GuidanceMessage>()
    private val goalCommandTimeouts = mutableMapOf<String, Runnable>()
    private val goalCommandsInFlight = mutableMapOf<String, GoalCommandMessage>()
    private val offlineNotified = mutableSetOf<String>()
    private val healthyConnections = mutableSetOf<String>()
    private val lastTransportSuccess = mutableMapOf<String, Long>()
    private var pendingUpdateOffer: UpdateOffer? = null
    private var lastUpdateReminderAt = 0L
    private var lastNewReminderAt = 0L
    private var appVisible = false
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var connectivityManager: ConnectivityManager? = null
    private var monitoringActive = false
    private val handler = Handler(Looper.getMainLooper())
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            handler.post {
                if (!MonitorStore.monitoringEnabled.value) return@post
                MonitorStore.pairings().forEach { pairing ->
                    if (!sockets.containsKey(pairing.id)) connect(pairing)
                }
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        MonitorStore.initialize(this)
        createChannels()
        if (MonitorStore.monitoringEnabled.value) startMonitoring()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_SET_MONITORING -> {
                val enabled = intent.getBooleanExtra(EXTRA_MONITORING_ENABLED, true)
                MonitorStore.setMonitoringEnabled(enabled)
                if (enabled) {
                    startMonitoring()
                    MonitorStore.pairings().forEach(::connect)
                } else {
                    stopMonitoring()
                }
            }
            ACTION_APP_FOREGROUND -> markAppVisible()
            ACTION_APP_BACKGROUND -> appVisible = false
            ACTION_SET_CONNECTION_PREFERENCE -> {
                val id = intent.getStringExtra(EXTRA_DEVICE_ID) ?: return START_STICKY
                val preference = runCatching {
                    ConnectionPreference.valueOf(intent.getStringExtra(EXTRA_CONNECTION_PREFERENCE).orEmpty())
                }.getOrNull() ?: return START_STICKY
                MonitorStore.setConnectionPreference(id, preference)
                MonitorStore.pairings().firstOrNull { it.id == id }?.let { pairing ->
                    activeEndpoints.remove(id)
                    endpointIndexes.remove(id)
                    sockets.remove(id)?.cancel()
                    connect(pairing)
                }
            }
            ACTION_KEEP_ALIVE -> {
                if (MonitorStore.monitoringEnabled.value) {
                    startMonitoring()
                    MonitorStore.pairings().forEach { pairing ->
                        if (!sockets.containsKey(pairing.id)) connect(pairing)
                    }
                    runDueReminderChecks()
                    scheduleServiceRestart()
                } else {
                    cancelServiceRestart()
                    stopSelf()
                }
            }
            ACTION_SEND_GUIDANCE -> sendGuidance(intent)
            ACTION_SEND_GOAL_COMMAND -> sendGoalCommand(intent)
            ACTION_DISCONNECT -> intent.getStringExtra(EXTRA_DEVICE_ID)?.let(::disconnect)
            ACTION_CONNECT -> intent.getStringExtra(EXTRA_DEVICE_ID)?.let { id ->
                MonitorStore.pairings().firstOrNull { it.id == id }?.let { pairing ->
                    reconnectTasks.remove(id)?.let(handler::removeCallbacks)
                    cancelOfflineConfirmation(id)
                    healthyConnections.remove(id)
                    activeEndpoints.remove(id)
                    endpointIndexes.remove(id)
                    sockets.remove(id)?.cancel()
                    MonitorStore.setConnected(id, false)
                    connect(pairing)
                }
            }
            else -> if (MonitorStore.monitoringEnabled.value) {
                MonitorStore.pairings().forEach(::connect)
                scheduleServiceRestart()
            }
        }
        return if (MonitorStore.monitoringEnabled.value) START_STICKY else START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        sockets.values.forEach { it.cancel() }
        runCatching { connectivityManager?.unregisterNetworkCallback(networkCallback) }
        runCatching { if (wifiLock?.isHeld == true) wifiLock?.release() }
        runCatching { if (wakeLock?.isHeld == true) wakeLock?.release() }
        client.dispatcher.executorService.shutdown()
        if (MonitorStore.monitoringEnabled.value) scheduleServiceRestart()
        super.onDestroy()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        appVisible = false
        if (MonitorStore.monitoringEnabled.value) scheduleServiceRestart()
        super.onTaskRemoved(rootIntent)
    }

    private fun connect(pairing: PairingData) {
        if (!MonitorStore.monitoringEnabled.value || sockets.containsKey(pairing.id)) return
        val endpoints = pairing.endpoints(MonitorStore.connectionPreference(pairing.id))
        if (endpoints.isEmpty()) {
            MonitorStore.setConnected(pairing.id, false)
            refreshOverview()
            return
        }
        val index = (endpointIndexes[pairing.id] ?: 0) % endpoints.size
        val endpoint = endpoints[index]
        activeEndpoints[pairing.id] = endpoint
        val divider = if (endpoint.wsUrl.contains('?')) '&' else '?'
        val url = endpoint.wsUrl + divider + "token=" + URLEncoder.encode(pairing.token, Charsets.UTF_8.name())
        val request = Request.Builder().url(url).build()
        sockets[pairing.id] = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (sockets[pairing.id] !== webSocket) return
                webSocket.send(json.encodeToString(ClientInfoMessage.serializer(), clientInfoMessage()))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (sockets[pairing.id] !== webSocket) return
                val messageType = runCatching {
                    json.parseToJsonElement(text).jsonObject["type"]?.jsonPrimitive?.content
                }.getOrNull()
                if (messageType == "guidance_result") {
                    val result = runCatching { json.decodeFromString(GuidanceResult.serializer(), text) }.getOrNull() ?: return
                    val original = guidanceInFlight[result.requestId] ?: return
                    if (!ResponseValidationPolicy.guidanceMatches(original.sessionId, result.sessionId)) {
                        guidanceTimeouts.remove(result.requestId)?.let(handler::removeCallbacks)
                        guidanceInFlight.remove(result.requestId)
                        MonitorStore.setGuidanceStatus(
                            pairing.id,
                            original.sessionId,
                            GuidanceUi(
                                sending = false,
                                ok = false,
                                message = copyFailedGuidance(original, "电脑端返回了不匹配的会话结果，消息未确认"),
                            ),
                        )
                        return
                    }
                    guidanceTimeouts.remove(result.requestId)?.let(handler::removeCallbacks)
                    guidanceInFlight.remove(result.requestId)
                    val resultMessage = if (result.ok) result.message else copyFailedGuidance(original, result.message)
                    MonitorStore.setGuidanceStatus(
                        pairing.id,
                        result.sessionId,
                        GuidanceUi(sending = false, ok = result.ok, message = resultMessage),
                    )
                    if (result.ok) {
                        handler.postDelayed({
                            val current = MonitorStore.guidanceStatus.value["${pairing.id}:${result.sessionId}"]
                            if (current?.ok == true && !current.sending) {
                                MonitorStore.clearGuidanceStatus(pairing.id, result.sessionId)
                            }
                        }, 6_000L)
                    }
                    return
                }
                if (messageType == "guidance_ack") {
                    val ack = runCatching { json.decodeFromString(GuidanceAck.serializer(), text) }.getOrNull() ?: return
                    val original = guidanceInFlight[ack.requestId] ?: return
                    if (!ResponseValidationPolicy.guidanceMatches(original.sessionId, ack.sessionId)) {
                        guidanceTimeouts.remove(ack.requestId)?.let(handler::removeCallbacks)
                        guidanceInFlight.remove(ack.requestId)
                        MonitorStore.setGuidanceStatus(
                            pairing.id,
                            original.sessionId,
                            GuidanceUi(
                                sending = false,
                                ok = false,
                                message = copyFailedGuidance(original, "电脑端返回了不匹配的会话确认，消息未确认"),
                            ),
                        )
                        return
                    }
                    guidanceTimeouts.remove(ack.requestId)?.let(handler::removeCallbacks)
                    MonitorStore.setGuidanceStatus(
                        pairing.id,
                        ack.sessionId,
                        GuidanceUi(sending = true, ok = null, message = ack.message),
                    )
                    val timeout = Runnable {
                        guidanceTimeouts.remove(ack.requestId)
                        val original = guidanceInFlight.remove(ack.requestId)
                        MonitorStore.setGuidanceStatus(
                            pairing.id,
                            ack.sessionId,
                            GuidanceUi(
                                false,
                                false,
                                copyFailedGuidance(original, "电脑端已收到，但 30 秒未返回 Codex 最终执行结果"),
                            ),
                        )
                    }
                    guidanceTimeouts[ack.requestId] = timeout
                    handler.postDelayed(timeout, GUIDANCE_RESULT_TIMEOUT_MS)
                    return
                }
                if (messageType == "goal_command_result") {
                    val result = runCatching { json.decodeFromString(GoalCommandResult.serializer(), text) }.getOrNull() ?: return
                    val original = goalCommandsInFlight[result.requestId] ?: return
                    if (!ResponseValidationPolicy.goalMatches(
                            original.sessionId,
                            result.sessionId,
                            original.command,
                            result.command,
                        )
                    ) {
                        goalCommandTimeouts.remove(result.requestId)?.let(handler::removeCallbacks)
                        goalCommandsInFlight.remove(result.requestId)
                        MonitorStore.setGoalCommandStatus(
                            pairing.id,
                            original.sessionId,
                            GoalCommandUi(
                                sending = false,
                                ok = false,
                                message = "电脑端返回了不匹配的 Goal 操作结果，消息未确认",
                            ),
                        )
                        return
                    }
                    goalCommandTimeouts.remove(result.requestId)?.let(handler::removeCallbacks)
                    goalCommandsInFlight.remove(result.requestId)
                    MonitorStore.setGoalCommandStatus(
                        pairing.id,
                        result.sessionId,
                        GoalCommandUi(sending = false, ok = result.ok, message = result.message),
                    )
                    if (result.ok) {
                        handler.postDelayed({
                            val current = MonitorStore.goalCommandStatus.value["${pairing.id}:${result.sessionId}"]
                            if (current?.ok == true && !current.sending) {
                                MonitorStore.clearGoalCommandStatus(pairing.id, result.sessionId)
                            }
                        }, 6_000L)
                    }
                    return
                }
                if (messageType == "goal_command_ack") {
                    val ack = runCatching { json.decodeFromString(GoalCommandAck.serializer(), text) }.getOrNull() ?: return
                    val original = goalCommandsInFlight[ack.requestId] ?: return
                    if (!ResponseValidationPolicy.guidanceMatches(original.sessionId, ack.sessionId)) {
                        goalCommandTimeouts.remove(ack.requestId)?.let(handler::removeCallbacks)
                        goalCommandsInFlight.remove(ack.requestId)
                        MonitorStore.setGoalCommandStatus(
                            pairing.id,
                            original.sessionId,
                            GoalCommandUi(
                                sending = false,
                                ok = false,
                                message = "电脑端返回了不匹配的 Goal 会话确认，消息未确认",
                            ),
                        )
                        return
                    }
                    goalCommandTimeouts.remove(ack.requestId)?.let(handler::removeCallbacks)
                    MonitorStore.setGoalCommandStatus(
                        pairing.id,
                        ack.sessionId,
                        GoalCommandUi(sending = true, ok = null, message = ack.message),
                    )
                    val timeout = Runnable {
                        goalCommandTimeouts.remove(ack.requestId)
                        MonitorStore.setGoalCommandStatus(
                            pairing.id,
                            ack.sessionId,
                            GoalCommandUi(false, false, "电脑端已收到，但 30 秒未返回 Goal 最终执行结果"),
                        )
                    }
                    goalCommandTimeouts[ack.requestId] = timeout
                    handler.postDelayed(timeout, GOAL_RESULT_TIMEOUT_MS)
                    return
                }
                val snapshot = runCatching { json.decodeFromString(WireSnapshot.serializer(), text) }.getOrNull() ?: return
                if (snapshot.type != "snapshot" || snapshot.machine.id != pairing.id) return
                healthyConnections.add(pairing.id)
                lastTransportSuccess[pairing.id] = System.currentTimeMillis()
                cancelOfflineConfirmation(pairing.id)
                MonitorStore.updateMachineName(pairing.id, snapshot.machine.name)
                val previous = MonitorStore.devices.value.firstOrNull { it.pairing.id == pairing.id }?.sessions.orEmpty()
                    .associateBy { it.id }
                val persistedStates = MonitorStore.persistedSessionStates(pairing.id)
                val changedSessions = mutableListOf<Pair<SessionStatus, String>>()
                snapshot.sessions.forEach { session ->
                    val key = "${pairing.id}:${session.id}"
                    val oldState = SessionStateRestorePolicy.previousState(
                        liveState = latestStates[key],
                        cachedState = previous[session.id]?.state,
                        persistedState = persistedStates[session.id],
                    )
                    latestStates[key] = session.state
                    if (oldState == null) {
                        notifiedStates[key] = session.state
                    } else if (oldState != session.state) {
                        changedSessions += session to oldState
                    }
                }
                MonitorStore.applySnapshot(pairing.id, snapshot.sessions, System.currentTimeMillis())
                changedSessions.forEach { (session, oldState) ->
                    if (JarvisNotificationPolicy.isSilentCompletion(
                            MonitorStore.isJarvisSession(pairing.id, session.id), oldState, session.state,
                        )
                    ) {
                        MonitorStore.markSilentUnread(pairing.id, session.id)
                    }
                }
                if (appVisible && changedSessions.isNotEmpty()) {
                    changedSessions.forEach { (session, _) ->
                        notifiedStates["${pairing.id}:${session.id}"] = session.state
                    }
                    if (changedSessions.any { (session, oldState) ->
                            !JarvisNotificationPolicy.isSilentCompletion(
                                MonitorStore.isJarvisSession(pairing.id, session.id), oldState, session.state,
                            )
                        }) {
                        playForegroundStateSound()
                    }
                } else {
                    changedSessions.forEach { (session, oldState) ->
                        val silent = JarvisNotificationPolicy.isSilentCompletion(
                            MonitorStore.isJarvisSession(pairing.id, session.id), oldState, session.state,
                        )
                        scheduleSessionNotification(
                            pairing,
                            session,
                            silent,
                        )
                    }
                }
                refreshOverview()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = failed(webSocket)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = failed(webSocket)

            private fun failed(webSocket: WebSocket) {
                if (sockets[pairing.id] !== webSocket) return
                sockets.remove(pairing.id)
                healthyConnections.remove(pairing.id)
                advanceEndpoint(pairing)
                scheduleOfflineConfirmation(pairing)
                scheduleReconnect(pairing)
            }
        })
    }

    private fun disconnect(id: String) {
        sockets.remove(id)?.close(1000, "Disconnected on phone")
        activeEndpoints.remove(id)
        endpointIndexes.remove(id)
        healthyConnections.remove(id)
        lastTransportSuccess.remove(id)
        cancelOfflineConfirmation(id)
        reconnectTasks.remove(id)?.let(handler::removeCallbacks)
        MonitorStore.remove(id)
        latestStates.keys.removeAll { it.startsWith("$id:") }
        notifiedStates.keys.removeAll { it.startsWith("$id:") }
        pendingNotifications.keys.filter { it.startsWith("$id:") }.forEach { key ->
            pendingNotifications.remove(key)?.let(handler::removeCallbacks)
        }
        offlineNotified.remove(id)
        refreshOverview()
    }

    private fun sendGuidance(intent: Intent) {
        val deviceId = intent.getStringExtra(EXTRA_DEVICE_ID) ?: return
        val sessionId = intent.getStringExtra(EXTRA_SESSION_ID) ?: return
        val requestId = intent.getStringExtra(EXTRA_REQUEST_ID) ?: return
        val message = MonitorStore.takeGuidance(requestId)
        if (message == null || message.sessionId != sessionId) {
            MonitorStore.setGuidanceStatus(deviceId, sessionId, GuidanceUi(false, false, "待发送内容已失效，请重试"))
            return
        }
        if (!MonitorStore.monitoringEnabled.value) {
            MonitorStore.setGuidanceStatus(
                deviceId,
                sessionId,
                GuidanceUi(false, false, copyFailedGuidance(message, "监控已关闭，请先打开总开关")),
            )
            return
        }
        if ((message.text.isBlank() && message.attachments.isEmpty()) || message.text.length > 2000) {
            MonitorStore.setGuidanceStatus(
                deviceId,
                sessionId,
                GuidanceUi(false, false, copyFailedGuidance(message, "请输入消息或选择图片，文字不能超过 2000 字")),
            )
            return
        }
        val socket = sockets[deviceId]
        if (socket == null || deviceId !in healthyConnections) {
            val firstAttemptAt = intent.getLongExtra(EXTRA_FIRST_ATTEMPT_AT, System.currentTimeMillis())
            if (System.currentTimeMillis() - firstAttemptAt < GUIDANCE_RECONNECT_TIMEOUT_MS) {
                MonitorStore.queueGuidance(message)
                MonitorStore.setGuidanceStatus(deviceId, sessionId, GuidanceUi(true, null, "连接正在恢复，恢复后自动发送"))
                if (socket == null) {
                    MonitorStore.pairings().firstOrNull { it.id == deviceId }?.let(::connect)
                }
                val retry = Intent(intent).putExtra(EXTRA_FIRST_ATTEMPT_AT, firstAttemptAt)
                handler.postDelayed({ sendGuidance(retry) }, GUIDANCE_RECONNECT_RETRY_MS)
            } else {
                MonitorStore.setGuidanceStatus(
                    deviceId,
                    sessionId,
                    GuidanceUi(
                        false,
                        false,
                        copyFailedGuidance(message, "连接恢复超时，请确认 Windows Monitor 在线后重试"),
                    ),
                )
            }
            return
        }
        guidanceInFlight[requestId] = message
        val sent = socket.send(json.encodeToString(GuidanceMessage.serializer(), message))
        if (!sent) guidanceInFlight.remove(requestId)
        MonitorStore.setGuidanceStatus(
            deviceId,
            sessionId,
            if (sent) GuidanceUi(true, null, "正在交给电脑端 Codex")
            else GuidanceUi(false, false, copyFailedGuidance(message, "消息发送失败")),
        )
        if (sent) {
            guidanceTimeouts.remove(requestId)?.let(handler::removeCallbacks)
            val timeout = Runnable {
                guidanceTimeouts.remove(requestId)
                val original = guidanceInFlight.remove(requestId)
                MonitorStore.setGuidanceStatus(
                    deviceId,
                    sessionId,
                    GuidanceUi(
                        false,
                        false,
                        copyFailedGuidance(original, "电脑端 5 秒未确认收到，请确认连接后重试"),
                    ),
                )
            }
            guidanceTimeouts[requestId] = timeout
            handler.postDelayed(timeout, 5_000L)
        }
    }

    private fun copyFailedGuidance(message: GuidanceMessage?, reason: String): String {
        val text = message?.text?.trim().orEmpty()
        if (text.isEmpty()) return reason
        getSystemService(ClipboardManager::class.java).setPrimaryClip(
            ClipData.newPlainText("Codex Monitor 发送失败内容", text),
        )
        return "$reason；本次文字已复制到剪贴板"
    }

    private fun sendGoalCommand(intent: Intent) {
        val deviceId = intent.getStringExtra(EXTRA_DEVICE_ID) ?: return
        val sessionId = intent.getStringExtra(EXTRA_SESSION_ID) ?: return
        val requestId = intent.getStringExtra(EXTRA_REQUEST_ID) ?: return
        val command = intent.getStringExtra(EXTRA_GOAL_COMMAND).takeIf { it == "resume" || it == "delete" }
        val confirmed = intent.getBooleanExtra(EXTRA_GOAL_CONFIRMED, false)
        if (!MonitorStore.monitoringEnabled.value) {
            MonitorStore.setGoalCommandStatus(deviceId, sessionId, GoalCommandUi(false, false, "监控已关闭，请先打开总开关"))
            return
        }
        if (command == null || (command == "delete" && !confirmed)) {
            MonitorStore.setGoalCommandStatus(deviceId, sessionId, GoalCommandUi(false, false, "Goal 操作无效或尚未确认"))
            return
        }
        val socket = sockets[deviceId]
        if (socket == null || deviceId !in healthyConnections) {
            val firstAttemptAt = intent.getLongExtra(EXTRA_FIRST_ATTEMPT_AT, System.currentTimeMillis())
            if (System.currentTimeMillis() - firstAttemptAt < GUIDANCE_RECONNECT_TIMEOUT_MS) {
                MonitorStore.setGoalCommandStatus(deviceId, sessionId, GoalCommandUi(true, null, "连接正在恢复，恢复后自动执行"))
                if (socket == null) {
                    MonitorStore.pairings().firstOrNull { it.id == deviceId }?.let(::connect)
                }
                val retry = Intent(intent).putExtra(EXTRA_FIRST_ATTEMPT_AT, firstAttemptAt)
                handler.postDelayed({ sendGoalCommand(retry) }, GUIDANCE_RECONNECT_RETRY_MS)
            } else {
                MonitorStore.setGoalCommandStatus(
                    deviceId,
                    sessionId,
                    GoalCommandUi(false, false, "连接恢复超时，请确认 Windows Monitor 在线后重试"),
                )
            }
            return
        }
        val message = GoalCommandMessage(requestId = requestId, sessionId = sessionId, command = command, confirmed = confirmed)
        goalCommandsInFlight[requestId] = message
        val sent = socket.send(json.encodeToString(GoalCommandMessage.serializer(), message))
        if (!sent) goalCommandsInFlight.remove(requestId)
        MonitorStore.setGoalCommandStatus(
            deviceId,
            sessionId,
            if (sent) GoalCommandUi(true, null, "正在交给电脑端 Codex") else GoalCommandUi(false, false, "Goal 操作发送失败"),
        )
        if (sent) {
            val timeout = Runnable {
                goalCommandTimeouts.remove(requestId)
                goalCommandsInFlight.remove(requestId)
                MonitorStore.setGoalCommandStatus(deviceId, sessionId, GoalCommandUi(false, false, "电脑端 10 秒未返回 Goal 操作结果"))
            }
            goalCommandTimeouts[requestId] = timeout
            handler.postDelayed(timeout, 10_000L)
        }
    }

    private val staleCheck = object : Runnable {
        override fun run() {
            if (!MonitorStore.monitoringEnabled.value) return
            val now = System.currentTimeMillis()
            MonitorStore.devices.value.forEach { device ->
                val lastSuccess = lastTransportSuccess[device.pairing.id] ?: device.lastSeenMs
                if (healthyConnections.contains(device.pairing.id) && lastSuccess != null && now - lastSuccess >= OFFLINE_CONFIRM_MS) {
                    sockets.remove(device.pairing.id)?.cancel()
                    healthyConnections.remove(device.pairing.id)
                    scheduleOfflineConfirmation(device.pairing)
                    scheduleReconnect(device.pairing)
                }
            }
            handler.postDelayed(this, 5_000)
        }
    }

    private val newReminderCheck = object : Runnable {
        override fun run() {
            if (!MonitorStore.monitoringEnabled.value) return
            checkNewReminder(SystemClock.elapsedRealtime())
            handler.postDelayed(this, 5_000L)
        }
    }

    private val connectionWatchdog = object : Runnable {
        override fun run() {
            if (!MonitorStore.monitoringEnabled.value) return
            MonitorStore.pairings().forEach { pairing ->
                if (!sockets.containsKey(pairing.id)) connect(pairing)
            }
            handler.postDelayed(this, 15_000L)
        }
    }

    private val serviceHeartbeat = object : Runnable {
        override fun run() {
            if (!MonitorStore.monitoringEnabled.value) return
            val now = System.currentTimeMillis()
            val preferences = getSharedPreferences("codex_monitor", MODE_PRIVATE)
            val previous = preferences.getLong(HEARTBEAT_PREF, 0L)
            BackgroundWatchdog.diagnostic(previous, now)?.let(MonitorStore::setBackgroundDiagnostic)
            preferences.edit().putLong(HEARTBEAT_PREF, now).apply()
            if (BackgroundWatchdog.isFrozen(previous, now)) {
                pendingNotifications.keys.toList().forEach { key ->
                    pendingNotifications.remove(key)?.let(handler::removeCallbacks)
                }
                notifiedStates.clear()
                latestStates.forEach { (key, state) -> notifiedStates[key] = state }
                if (!appVisible) {
                    MonitorStore.devices.value.forEach { device ->
                        MonitorStore.setBackgroundDiagnostic("后台被系统冻结，状态已在恢复后同步，未丢失通知")
                    }
                }
            }
            handler.postDelayed(this, HEARTBEAT_MS)
        }
    }

    private fun scheduleOfflineConfirmation(pairing: PairingData) {
        if (!MonitorStore.monitoringEnabled.value) return
        if (pendingOffline.containsKey(pairing.id)) return
        val lastSuccess = lastTransportSuccess[pairing.id] ?: System.currentTimeMillis()
        val remaining = maxOf(0L, OFFLINE_CONFIRM_MS - (System.currentTimeMillis() - lastSuccess))
        val task = Runnable {
            confirmComputerOffline(pairing, attemptsRemaining = 3)
        }
        pendingOffline[pairing.id] = task
        handler.postDelayed(task, remaining)
    }

    private fun confirmComputerOffline(pairing: PairingData, attemptsRemaining: Int) {
        if (healthyConnections.contains(pairing.id) || !MonitorStore.isPaired(pairing.id)) {
            cancelOfflineConfirmation(pairing.id)
            return
        }
        val endpointUrl = activeEndpoints[pairing.id]?.wsUrl
            ?: pairing.endpoints(MonitorStore.connectionPreference(pairing.id)).firstOrNull()?.wsUrl
        val base = endpointUrl?.let { runCatching { URI(it) }.getOrNull() }
        val healthUrl = runCatching {
            URI(
                if (base?.scheme == "wss") "https" else "http",
                null,
                base?.host ?: return@runCatching null,
                base.port,
                "/health",
                null,
                null,
            ).toString()
        }.getOrNull()
        if (healthUrl == null) {
            finishOfflineConfirmation(pairing)
            return
        }
        client.newCall(Request.Builder().url(healthUrl).build()).enqueue(object : Callback {
            override fun onFailure(call: Call, error: IOException) = handleResult(false)

            override fun onResponse(call: Call, response: Response) {
                response.use { handleResult(it.isSuccessful) }
            }

            private fun handleResult(reachable: Boolean) {
                handler.post {
                    if (!MonitorStore.monitoringEnabled.value) {
                        cancelOfflineConfirmation(pairing.id)
                        MonitorStore.setConnected(pairing.id, false)
                    } else if (healthyConnections.contains(pairing.id) || !MonitorStore.isPaired(pairing.id)) {
                        cancelOfflineConfirmation(pairing.id)
                    } else if (reachable && attemptsRemaining > 1) {
                        // A reachable health endpoint does not prove that session snapshots
                        // are flowing. Keep the cached lamps stale only during the confirmation
                        // window and restore colors exclusively after a fresh WebSocket snapshot.
                        sockets.remove(pairing.id)?.cancel()
                        connect(pairing)
                        val retry = Runnable { confirmComputerOffline(pairing, attemptsRemaining - 1) }
                        pendingOffline[pairing.id] = retry
                        handler.postDelayed(retry, 5_000L)
                    } else if (reachable) {
                        sockets.remove(pairing.id)?.cancel()
                        connect(pairing)
                        finishOfflineConfirmation(pairing)
                    } else if (attemptsRemaining > 1) {
                        val retry = Runnable { confirmComputerOffline(pairing, attemptsRemaining - 1) }
                        pendingOffline[pairing.id] = retry
                        handler.postDelayed(retry, 5_000L)
                    } else {
                        finishOfflineConfirmation(pairing)
                    }
                }
            }
        })
    }

    private fun finishOfflineConfirmation(pairing: PairingData) {
        pendingOffline.remove(pairing.id)
        if (healthyConnections.contains(pairing.id) || !MonitorStore.isPaired(pairing.id)) return
        MonitorStore.setConnected(pairing.id, false)
        refreshOverview()
        if (offlineNotified.add(pairing.id) && !appVisible) notifyConnectionLost(pairing)
    }

    private fun cancelOfflineConfirmation(id: String) {
        pendingOffline.remove(id)?.let(handler::removeCallbacks)
    }

    private fun advanceEndpoint(pairing: PairingData) {
        val count = pairing.endpoints(MonitorStore.connectionPreference(pairing.id)).size
        if (count > 1) endpointIndexes[pairing.id] = ((endpointIndexes[pairing.id] ?: 0) + 1) % count
    }

    private fun scheduleReconnect(pairing: PairingData) {
        if (!MonitorStore.monitoringEnabled.value) return
        if (reconnectTasks.containsKey(pairing.id)) return
        val task = Runnable {
            reconnectTasks.remove(pairing.id)
            if (MonitorStore.isPaired(pairing.id) && !sockets.containsKey(pairing.id)) connect(pairing)
        }
        reconnectTasks[pairing.id] = task
        handler.postDelayed(task, RECONNECT_DELAY_MS)
    }

    private fun markAppVisible() {
        appVisible = true
        pendingUpdateOffer = null
        lastUpdateReminderAt = 0L
        NotificationManagerCompat.from(this).cancel(UPDATE_NOTIFICATION)
        if (pendingNotifications.isNotEmpty()) playForegroundStateSound()
        pendingNotifications.forEach { (key, task) ->
            handler.removeCallbacks(task)
            latestStates[key]?.let { notifiedStates[key] = it }
        }
        pendingNotifications.clear()
        val preferences = getSharedPreferences("codex_monitor", MODE_PRIVATE)
        val previous = preferences.getLong(HEARTBEAT_PREF, 0L)
        val now = System.currentTimeMillis()
        if (BackgroundWatchdog.isFrozen(previous, now)) {
            MonitorStore.setBackgroundDiagnostic(
                "后台曾冻结 ${(now - previous) / 1_000} 秒，状态已自动恢复基线",
            )
        }
    }

    private fun playForegroundStateSound() {
        runCatching {
            val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            RingtoneManager.getRingtone(applicationContext, uri)?.play()
        }
    }

    private fun acquireBackgroundLocks() {
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CodexMonitor:SessionMonitoring")
            .apply {
                setReferenceCounted(false)
                acquire()
            }
        @Suppress("DEPRECATION")
        wifiLock = (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager)
            .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "CodexMonitor:LanMonitoring")
            .apply {
                setReferenceCounted(false)
                acquire()
            }
    }

    private fun registerNetworkCallback() {
        connectivityManager = getSystemService(ConnectivityManager::class.java)
        runCatching { connectivityManager?.registerDefaultNetworkCallback(networkCallback) }
    }

    private fun scheduleServiceRestart() {
        if (!KeepAliveAlarmPolicy.shouldSchedule(MonitorStore.monitoringEnabled.value)) {
            cancelServiceRestart()
            return
        }
        val alarmManager = getSystemService(AlarmManager::class.java)
        val triggerAt = SystemClock.elapsedRealtime() + 60_000L
        val mode = KeepAliveAlarmPolicy.mode(
            sdkInt = Build.VERSION.SDK_INT,
            canScheduleExactAlarms = Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
                alarmManager.canScheduleExactAlarms(),
        )
        val exactScheduled = mode == KeepAliveAlarmMode.EXACT && runCatching {
            alarmManager.setExactAndAllowWhileIdle(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                triggerAt,
                keepAlivePendingIntent(),
            )
        }.isSuccess
        if (!exactScheduled) {
            alarmManager.setAndAllowWhileIdle(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                triggerAt,
                keepAlivePendingIntent(),
            )
        }
    }

    private fun cancelServiceRestart() {
        getSystemService(AlarmManager::class.java).cancel(keepAlivePendingIntent())
    }

    private fun keepAlivePendingIntent(): PendingIntent = PendingIntent.getForegroundService(
        this,
        73,
        Intent(this, ConnectionService::class.java).setAction(ACTION_KEEP_ALIVE),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun checkNewReminder(now: Long) {
        val hasUnreadChange = MonitorStore.devices.value.any { it.newSessionIds.isNotEmpty() }
        if (!hasUnreadChange) lastNewReminderAt = 0L
        else if (lastNewReminderAt == 0L) lastNewReminderAt = now
        else if (now - lastNewReminderAt >= NEW_REMINDER_MS) {
            lastNewReminderAt = now
            notifyUnreadReminder()
        }
        if (!hasUnreadChange) NotificationManagerCompat.from(this).cancel(UNREAD_NOTIFICATION)
    }

    private fun runDueReminderChecks() {
        val now = SystemClock.elapsedRealtime()
        checkNewReminder(now)
        if (UpdateReminderPolicy.isDue(pendingUpdateOffer != null, appVisible, lastUpdateReminderAt, now)) {
            pendingUpdateOffer?.let(::notifyUpdateAvailable)
            lastUpdateReminderAt = now
        }
    }

    private fun clientInfoMessage(): ClientInfoMessage {
        val packageInfo = packageManager.getPackageInfo(packageName, 0)
        val versionCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            packageInfo.longVersionCode
        } else {
            @Suppress("DEPRECATION")
            packageInfo.versionCode.toLong()
        }
        return ClientInfoMessage(
            appVersion = packageInfo.versionName ?: "unknown",
            versionCode = versionCode,
        )
    }

    private val updateCheck = object : Runnable {
        override fun run() {
            if (!MonitorStore.monitoringEnabled.value) return
            val pairings = MonitorStore.pairings()
            if (pairings.isNotEmpty()) {
                AppUpdater.check(this@ConnectionService, pairings) { result ->
                    if (!MonitorStore.monitoringEnabled.value) return@check
                    result.onSuccess { offer ->
                        if (offer == null || appVisible) {
                            pendingUpdateOffer = null
                            lastUpdateReminderAt = 0L
                        } else if (pendingUpdateOffer?.manifest?.versionCode != offer.manifest.versionCode) {
                            pendingUpdateOffer = offer
                            lastUpdateReminderAt = 0L
                        }
                    }
                }
            } else {
                pendingUpdateOffer = null
                lastUpdateReminderAt = 0L
            }
            handler.postDelayed(this, UPDATE_CHECK_MS)
        }
    }

    private val updateReminderCheck = object : Runnable {
        override fun run() {
            if (!MonitorStore.monitoringEnabled.value) return
            runDueReminderChecks()
            handler.postDelayed(this, 5_000L)
        }
    }

    private fun startMonitoring() {
        if (monitoringActive) return
        monitoringActive = true
        acquireBackgroundLocks()
        registerNetworkCallback()
        startForeground(SERVICE_NOTIFICATION, serviceNotification())
        handler.post(staleCheck)
        handler.post(newReminderCheck)
        handler.post(connectionWatchdog)
        handler.post(serviceHeartbeat)
        handler.postDelayed(updateCheck, 10_000L)
        handler.post(updateReminderCheck)
        scheduleServiceRestart()
    }

    private fun stopMonitoring() {
        monitoringActive = false
        handler.removeCallbacksAndMessages(null)
        sockets.values.forEach { it.cancel() }
        sockets.clear()
        healthyConnections.clear()
        pendingOffline.clear()
        reconnectTasks.clear()
        pendingNotifications.clear()
        guidanceTimeouts.clear()
        guidanceInFlight.clear()
        goalCommandsInFlight.clear()
        goalCommandTimeouts.clear()
        lastTransportSuccess.clear()
        cancelServiceRestart()
        getSharedPreferences("codex_monitor", MODE_PRIVATE).edit().remove(HEARTBEAT_PREF).apply()
        MonitorStore.pairings().forEach { MonitorStore.setConnected(it.id, false) }
        runCatching { connectivityManager?.unregisterNetworkCallback(networkCallback) }
        connectivityManager = null
        runCatching { if (wifiLock?.isHeld == true) wifiLock?.release() }
        wifiLock = null
        runCatching { if (wakeLock?.isHeld == true) wakeLock?.release() }
        wakeLock = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun createChannels() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL_SERVICE, "连接状态", NotificationManager.IMPORTANCE_LOW))
        manager.createNotificationChannel(NotificationChannel(CHANNEL_EVENTS, "Codex 会话提醒", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Codex 会话运行、完成和受阻状态"
            enableVibration(true)
        })
        manager.createNotificationChannel(NotificationChannel(CHANNEL_JARVIS, "贾维斯巡检完成", NotificationManager.IMPORTANCE_LOW).apply {
            setSound(null, null)
            enableVibration(false)
        })
        manager.createNotificationChannel(NotificationChannel(CHANNEL_UNREAD, "未读状态重复提醒", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "未查看的会话状态变化每 60 秒播放一次声音，不显示顶部横幅"
            enableVibration(false)
            setSound(
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT).build(),
            )
        })
    }

    private fun contentIntent(): PendingIntent = PendingIntent.getActivity(
        this,
        0,
        Intent(this, MainActivity::class.java),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun serviceNotification() = NotificationCompat.Builder(this, CHANNEL_SERVICE)
        .setSmallIcon(R.drawable.ic_launcher)
        .setContentTitle("Codex Monitor 正在监听")
        .setContentText("已保存 ${MonitorStore.pairings().size} 台电脑")
        .setOngoing(true)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .setContentIntent(contentIntent())
        .build()

    private fun refreshOverview() {
        postNotification(SERVICE_NOTIFICATION, overviewNotification())
    }

    private fun overviewNotification(): android.app.Notification {
        val devices = MonitorStore.devices.value
        val sessions = devices.filter { it.connected }.flatMap { it.sessions }
        val running = sessions.count { it.state == "running" }
        val blocked = sessions.count { it.state == "blocked" }
        val completed = sessions.count { it.state == "completed" }
        val unknown = devices.filter { it.connected }.sumOf { device ->
            device.sessions.count { it.state == "unknown" }
        } + devices.filter { !it.connected }.sumOf { maxOf(1, it.sessions.size) }
        val summary = "🟢 $running · 🔴 $blocked · 🔵 $completed · ⚫ $unknown"
        val style = NotificationCompat.InboxStyle().setSummaryText(summary)
        devices.take(6).forEach { device ->
            val lights = if (!device.connected) "⚫".repeat(maxOf(1, device.sessions.size)) else device.sessions.joinToString("") {
                when (it.state) {
                    "running" -> "🟢"
                    "blocked" -> "🔴"
                    "completed" -> "🔵"
                    else -> "⚫"
                }
            }.ifEmpty { "⚪" }
            style.addLine("${device.pairing.name}  $lights")
        }
        return NotificationCompat.Builder(this, CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Codex Monitor · ${devices.size} 台电脑")
            .setContentText(summary)
            .setStyle(style)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(contentIntent())
            .build()
    }

    private fun notifySession(pairing: PairingData, session: SessionStatus, silent: Boolean = false) {
        val (label, color) = when (session.state) {
            "running" -> "正在运行" to Color.rgb(36, 160, 101)
            "blocked" -> "发生错误或受阻" to Color.rgb(216, 74, 74)
            "completed" -> "已完成" to Color.rgb(49, 132, 216)
            else -> "状态未知" to Color.rgb(35, 39, 37)
        }
        val notification = NotificationCompat.Builder(this, if (silent) CHANNEL_JARVIS else CHANNEL_EVENTS)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("${pairing.name} · $label")
            .setContentText(session.title)
            .setStyle(NotificationCompat.BigTextStyle().bigText("${session.title}\n${session.message}"))
            .setColor(color)
            .setSilent(silent)
            .setAutoCancel(true)
            .setContentIntent(contentIntent())
            .build()
        postNotification((pairing.id + session.id).hashCode(), notification)
    }

    private fun notifyUnreadReminder() {
        val count = MonitorStore.audibleUnreadCount()
        if (count == 0) return
        val notification = NotificationCompat.Builder(this, CHANNEL_UNREAD)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("仍有 $count 个未查看的状态变化")
            .setContentText("点击进入 Codex Monitor 查看闪烁的 NEW 会话")
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setSilent(true)
            .setWhen(System.currentTimeMillis())
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(contentIntent())
            .build()
        postNotification(UNREAD_NOTIFICATION, notification)
        if (notificationsAllowed()) playForegroundStateSound()
    }

    private fun scheduleSessionNotification(pairing: PairingData, session: SessionStatus, silent: Boolean) {
        val key = "${pairing.id}:${session.id}"
        lastNewReminderAt = SystemClock.elapsedRealtime()
        pendingNotifications.remove(key)?.let(handler::removeCallbacks)
        val delayMs = if (session.state == "running") 20_000L else 1_200L
        val task = Runnable {
            pendingNotifications.remove(key)
            if (latestStates[key] != session.state) return@Runnable
            if (notifiedStates[key] == session.state) return@Runnable
            notifiedStates[key] = session.state
            notifySession(pairing, session, silent)
        }
        pendingNotifications[key] = task
        handler.postDelayed(task, delayMs)
    }

    private fun notifyConnectionLost(pairing: PairingData) {
        val notification = NotificationCompat.Builder(this, CHANNEL_EVENTS)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("${pairing.name} · 状态未知")
            .setContentText("电脑断线或监控端已关闭，正在自动重连")
            .setColor(Color.rgb(35, 39, 37))
            .setAutoCancel(true)
            .setContentIntent(contentIntent())
            .build()
        postNotification(pairing.id.hashCode(), notification)
    }

    private fun notifyUpdateAvailable(offer: UpdateOffer) {
        val notification = NotificationCompat.Builder(this, CHANNEL_EVENTS)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Codex Monitor ${offer.manifest.versionName} 可更新")
            .setContentText("点击打开应用并更新")
            .setColor(Color.rgb(49, 132, 216))
            .setWhen(System.currentTimeMillis())
            .setOnlyAlertOnce(false)
            .setAutoCancel(true)
            .setContentIntent(contentIntent())
            .build()
        postNotification(UPDATE_NOTIFICATION, notification)
    }

    private fun postNotification(id: Int, notification: android.app.Notification) {
        if (!notificationsAllowed()) return
        runCatching { notifyWithGrantedPermission(id, notification) }
    }

    @android.annotation.SuppressLint("MissingPermission")
    private fun notifyWithGrantedPermission(id: Int, notification: android.app.Notification) {
        NotificationManagerCompat.from(this).notify(id, notification)
    }

    private fun notificationsAllowed(): Boolean = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
}
