package com.codexmonitor.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action !in setOf(
                Intent.ACTION_BOOT_COMPLETED,
                Intent.ACTION_LOCKED_BOOT_COMPLETED,
                Intent.ACTION_MY_PACKAGE_REPLACED,
            )
        ) return
        MonitorStore.initialize(context)
        if (!MonitorStore.monitoringEnabled.value) return
        runCatching {
            ContextCompat.startForegroundService(context, Intent(context, ConnectionService::class.java))
        }
    }
}
