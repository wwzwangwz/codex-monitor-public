package com.codexmonitor.mobile

enum class KeepAliveAlarmMode {
    EXACT,
    INEXACT,
}

object KeepAliveAlarmPolicy {
    fun mode(sdkInt: Int, canScheduleExactAlarms: Boolean): KeepAliveAlarmMode =
        if (sdkInt < 31 || canScheduleExactAlarms) {
            KeepAliveAlarmMode.EXACT
        } else {
            KeepAliveAlarmMode.INEXACT
        }

    fun shouldSchedule(monitoringEnabled: Boolean): Boolean = monitoringEnabled
}
