package com.codexmonitor.mobile

import org.junit.Assert.assertTrue
import org.junit.Test

class BackgroundProtectionTest {
    @Test
    fun `routes common Android manufacturers to their background settings`() {
        listOf("Xiaomi", "Huawei", "Honor", "OPPO", "vivo", "Samsung").forEach { manufacturer ->
            assertTrue(manufacturer, BackgroundProtection.autoStartComponents(manufacturer).isNotEmpty())
        }
    }

    @Test
    fun `unknown manufacturers use application details fallback`() {
        assertTrue(BackgroundProtection.autoStartComponents("unknown").isEmpty())
    }
}
