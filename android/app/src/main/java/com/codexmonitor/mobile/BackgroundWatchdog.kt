package com.codexmonitor.mobile

object BackgroundWatchdog {
    const val FREEZE_THRESHOLD_MS = 30_000L

    fun isFrozen(previousHeartbeatMs: Long, nowMs: Long): Boolean {
        if (previousHeartbeatMs <= 0L || nowMs <= previousHeartbeatMs) return false
        return (nowMs - previousHeartbeatMs) >= FREEZE_THRESHOLD_MS
    }


    fun diagnostic(previousHeartbeatMs: Long, nowMs: Long): String? {
        if (previousHeartbeatMs <= 0L || nowMs <= previousHeartbeatMs) return null
        val gap = nowMs - previousHeartbeatMs
        if (gap < FREEZE_THRESHOLD_MS) return null
        val seconds = gap / 1_000L
        return if (seconds < 120) {
            "检测到 Android 系统暂停后台约 ${seconds} 秒，这段时间的状态只能在恢复后补收。"
        } else {
            "检测到 Android 系统暂停后台约 ${seconds / 60} 分钟，这段时间的状态只能在恢复后补收。"
        }
    }
}
