package com.codexmonitor.mobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateReminderPolicyTest {
    @Test fun foregroundCheckRunsOnFirstStartAndAfterOneMinute() {
        assertTrue(UpdateCheckPolicy.shouldCheck(lastCheckAt = 0, now = 1))
        assertFalse(UpdateCheckPolicy.shouldCheck(lastCheckAt = 1, now = 60_000))
        assertTrue(UpdateCheckPolicy.shouldCheck(lastCheckAt = 1, now = 60_001))
    }

    @Test fun foregroundCheckRetriesWhenClockMovesBackwards() {
        assertTrue(UpdateCheckPolicy.shouldCheck(lastCheckAt = 100_000, now = 99_999))
    }

    @Test
    fun `background update repeats only after sixty seconds`() {
        assertTrue(UpdateReminderPolicy.isDue(hasOffer = true, appVisible = false, lastReminderAt = 0, now = 1))
        assertFalse(UpdateReminderPolicy.isDue(hasOffer = true, appVisible = false, lastReminderAt = 1, now = 60_000))
        assertTrue(UpdateReminderPolicy.isDue(hasOffer = true, appVisible = false, lastReminderAt = 1, now = 60_001))
    }

    @Test
    fun `foreground or missing update never reminds`() {
        assertFalse(UpdateReminderPolicy.isDue(hasOffer = true, appVisible = true, lastReminderAt = 0, now = 100_000))
        assertFalse(UpdateReminderPolicy.isDue(hasOffer = false, appVisible = false, lastReminderAt = 0, now = 100_000))
    }
}
