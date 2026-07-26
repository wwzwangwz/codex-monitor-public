package com.codexmonitor.mobile

import android.app.AlarmManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings

object BackgroundProtection {
    fun manufacturerLabel(): String = Build.MANUFACTURER.trim().ifBlank { "Android" }

    fun openNotificationSettings(context: Context) {
        context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
            putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        })
    }

    fun openBatteryExemption(context: Context) {
        val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.parse("package:${context.packageName}")
        }
        runCatching { context.startActivity(direct) }
            .getOrElse { context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
    }

    fun exactAlarmsAllowed(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            context.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()

    fun openExactAlarmSettings(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        val direct = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM).apply {
            data = Uri.parse("package:${context.packageName}")
        }
        runCatching { context.startActivity(direct) }
            .getOrElse {
                context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.parse("package:${context.packageName}")
                })
            }
    }

    fun openAutoStartSettings(context: Context) {
        val launched = autoStartComponents(Build.MANUFACTURER).any { flattened ->
            runCatching {
                context.startActivity(Intent().apply {
                    component = ComponentName.unflattenFromString(flattened)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                })
            }.isSuccess
        }
        if (!launched) {
            context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:${context.packageName}")
            })
        }
    }

    internal fun autoStartComponents(manufacturer: String): List<String> = when (manufacturer.lowercase()) {
        "xiaomi", "redmi" -> listOf(
            "com.miui.securitycenter/com.miui.permcenter.autostart.AutoStartManagementActivity",
            "com.miui.securitycenter/com.miui.powercenter.PowerSettings",
        )
        "huawei" -> listOf(
            "com.huawei.systemmanager/.startupmgr.ui.StartupNormalAppListActivity",
            "com.huawei.systemmanager/.optimize.process.ProtectActivity",
        )
        "honor" -> listOf(
            "com.hihonor.systemmanager/.startupmgr.ui.StartupNormalAppListActivity",
            "com.huawei.systemmanager/.startupmgr.ui.StartupNormalAppListActivity",
        )
        "oppo", "oneplus", "realme" -> listOf(
            "com.coloros.safecenter/.startupapp.StartupAppListActivity",
            "com.oplus.battery/.appmanagement.AppManagementActivity",
            "com.oppo.safe/.permission.startup.StartupAppListActivity",
        )
        "vivo", "iqoo" -> listOf(
            "com.vivo.permissionmanager/.activity.BgStartUpManagerActivity",
            "com.iqoo.secure/.ui.phoneoptimize.BgStartUpManager",
            "com.vivo.abe/.ui.AbeMainActivity",
            "com.iqoo.secure/.ui.phoneoptimize.AddWhiteListActivity",
        )
        "samsung" -> listOf(
            "com.samsung.android.lool/.ui.battery.BatteryActivity",
            "com.samsung.android.sm/.app.dashboard.SmartManagerDashBoardActivity",
        )
        "asus" -> listOf("com.asus.mobilemanager/.entry.FunctionActivity")
        else -> emptyList()
    }
}
