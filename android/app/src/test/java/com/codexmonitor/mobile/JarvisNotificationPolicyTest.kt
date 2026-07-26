package com.codexmonitor.mobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class JarvisNotificationPolicyTest {
    @Test fun jarvisRunningToCompletedIsSilent() = assertTrue(JarvisNotificationPolicy.isSilentCompletion(true, "running", "completed"))
    @Test fun jarvisBlockedIsStillAudible() = assertFalse(JarvisNotificationPolicy.isSilentCompletion(true, "running", "blocked"))
    @Test fun regularCompletionIsStillAudible() = assertFalse(JarvisNotificationPolicy.isSilentCompletion(false, "running", "completed"))
}
