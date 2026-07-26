package com.codexmonitor.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BackgroundWatchdogTest {
    @Test
    fun ignoresNormalSchedulerJitter() {
        assertNull(BackgroundWatchdog.diagnostic(1_000L, 29_000L))
    }

    @Test
    fun reportsARealBackgroundFreeze() {
        assertEquals(
            "检测到 Android 系统暂停后台约 2 分钟，这段时间的状态只能在恢复后补收。",
            BackgroundWatchdog.diagnostic(1_000L, 121_000L),
        )
    }
}
