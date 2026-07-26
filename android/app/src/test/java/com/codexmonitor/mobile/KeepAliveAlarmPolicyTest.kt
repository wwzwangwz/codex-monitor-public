package com.codexmonitor.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KeepAliveAlarmPolicyTest {
    @Test
    fun `Android before twelve can use exact keep-alive without special access`() {
        assertEquals(
            KeepAliveAlarmMode.EXACT,
            KeepAliveAlarmPolicy.mode(sdkInt = 30, canScheduleExactAlarms = false),
        )
    }

    @Test
    fun `Android twelve and newer uses exact keep-alive only after permission`() {
        assertEquals(
            KeepAliveAlarmMode.INEXACT,
            KeepAliveAlarmPolicy.mode(sdkInt = 31, canScheduleExactAlarms = false),
        )
        assertEquals(
            KeepAliveAlarmMode.EXACT,
            KeepAliveAlarmPolicy.mode(sdkInt = 31, canScheduleExactAlarms = true),
        )
    }

    @Test
    fun `monitoring switch fully controls whether keep-alive is scheduled`() {
        assertTrue(KeepAliveAlarmPolicy.shouldSchedule(monitoringEnabled = true))
        assertFalse(KeepAliveAlarmPolicy.shouldSchedule(monitoringEnabled = false))
    }
}
