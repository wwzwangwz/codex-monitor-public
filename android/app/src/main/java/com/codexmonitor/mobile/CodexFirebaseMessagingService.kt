package com.codexmonitor.mobile

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class CodexFirebaseMessagingService : FirebaseMessagingService() {
    companion object {
        private const val CHANNEL_EVENTS = "codex_events"
        private const val CHANNEL_JARVIS = "codex_jarvis_quiet"
    }

    override fun onNewToken(token: String) {
        MonitorStore.initialize(this)
        PushRegistrationManager.storeTokenAndRegister(this, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        MonitorStore.initialize(this)
        val event = LampPushEvent.from(message.data) ?: return
        val changed = MonitorStore.applyPushTransition(event)
        if (!changed && !(event.reminder && MonitorStore.isUnread(event.deviceId, event.sessionId))) return
        if (AppVisibility.foreground) {
            if (!event.silent && notificationsAllowed()) runCatching {
                RingtoneManager.getRingtone(this, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)).play()
            }
            return
        }
        createChannels()
        val (label, color) = when (event.toState) {
            "running" -> "正在运行" to Color.rgb(36, 160, 101)
            "blocked" -> "发生错误或受阻" to Color.rgb(216, 74, 74)
            "completed" -> "已完成" to Color.rgb(49, 132, 216)
            else -> "状态未知" to Color.rgb(35, 39, 37)
        }
        val intent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(this, if (event.silent) CHANNEL_JARVIS else CHANNEL_EVENTS)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("${event.deviceName} · $label")
            .setContentText(event.sessionTitle)
            .setColor(color)
            .setSilent(event.silent)
            .setAutoCancel(true)
            .setContentIntent(intent)
            .build()
        postNotification((event.deviceId + event.sessionId).hashCode(), notification)
    }

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL_EVENTS, "Codex 会话提醒", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Codex 会话运行、完成和受阻状态"
            enableVibration(true)
        })
        manager.createNotificationChannel(NotificationChannel(CHANNEL_JARVIS, "贾维斯巡检完成", NotificationManager.IMPORTANCE_LOW).apply {
            setSound(null, null)
            enableVibration(false)
        })
    }

    private fun notificationsAllowed(): Boolean = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun postNotification(id: Int, notification: android.app.Notification) {
        if (!notificationsAllowed()) return
        notifyWithGrantedPermission(id, notification)
    }

    @SuppressLint("MissingPermission")
    private fun notifyWithGrantedPermission(id: Int, notification: android.app.Notification) {
        NotificationManagerCompat.from(this).notify(id, notification)
    }
}
