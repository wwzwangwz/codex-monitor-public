package com.codexmonitor.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PushProtocolTest {
    private val pairing = PairingData(
        v = 2,
        id = "00000000-0000-4000-8000-000000000001",
        name = "Primary Mac",
        wsUrl = "ws://192.168.1.2:43117/monitor",
        token = "0123456789abcdef0123456789abcdef",
        lanWsUrl = "ws://192.168.1.2:43117/monitor",
        relayWsUrl = "wss://relay.example/relay/phone/00000000-0000-4000-8000-000000000001",
    )

    @Test
    fun `builds an authenticated HTTPS registration endpoint while LAN remains primary`() {
        assertEquals(
            "https://relay.example/push/register/00000000-0000-4000-8000-000000000001?token=0123456789abcdef0123456789abcdef",
            PushRegistrationEndpoint.url(pairing),
        )
        assertEquals(
            "https://relay.example/push/read/00000000-0000-4000-8000-000000000001?token=0123456789abcdef0123456789abcdef",
            PushReadEndpoint.url(pairing),
        )
        assertEquals("ws://192.168.1.2:43117/monitor", pairing.endpoints(ConnectionPreference.AUTOMATIC).first().wsUrl)
    }

    @Test
    fun `accepts only real lamp transitions`() {
        val event = LampPushEvent.from(
            mapOf(
                "type" to "lamp_changed",
                "deviceId" to pairing.id,
                "deviceName" to pairing.name,
                "sessionId" to "session-1",
                "sessionTitle" to "开发",
                "fromState" to "running",
                "toState" to "completed",
                "silent" to "true",
                "reminder" to "true",
            ),
        )
        assertEquals("completed", event?.toState)
        assertEquals(true, event?.silent)
        assertEquals(true, event?.reminder)
        assertNull(LampPushEvent.from(mapOf("type" to "work_text_changed")))
        assertNull(LampPushEvent.from(mapOf(
            "type" to "lamp_changed", "deviceId" to pairing.id, "sessionId" to "s1",
            "fromState" to "running", "toState" to "running",
        )))
    }

    @Test
    fun `keeps a shared server path prefix for push endpoints`() {
        val sharedServerPairing = pairing.copy(
            relayWsUrl = "wss://relay.example.com/codex-monitor/relay/phone/${pairing.id}",
        )
        assertEquals(
            "https://relay.example.com/codex-monitor/push/register/${pairing.id}?token=${pairing.token}",
            PushRegistrationEndpoint.url(sharedServerPairing),
        )
        assertEquals(
            "https://relay.example.com/codex-monitor/push/read/${pairing.id}?token=${pairing.token}",
            PushReadEndpoint.url(sharedServerPairing),
        )
    }
}
