package com.codexmonitor.mobile

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class PairingCodecTest {
    @Test
    fun parsesDesktopPairingPayload() {
        val data = """{"v":1,"id":"mac-1","name":"MacBook","wsUrl":"ws://192.168.1.2:43117/monitor","token":"1234567890123456"}"""
        val encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(data.toByteArray())

        val pairing = PairingCodec.parse("codex-monitor://pair?data=$encoded")

        assertEquals("mac-1", pairing.id)
        assertEquals("MacBook", pairing.name)
        assertEquals("ws://192.168.1.2:43117/monitor", pairing.wsUrl)
    }

    @Test
    fun rejectsAnUnrelatedQrCode() {
        assertThrows(IllegalArgumentException::class.java) {
            PairingCodec.parse("https://example.com")
        }
    }

    @Test
    fun versionTwoKeepsLanAndRelaySeparateWithLanFirst() {
        val data = """{"v":2,"id":"mac-2","name":"Mac","wsUrl":"ws://192.168.1.2:43117/monitor","lanWsUrl":"ws://192.168.1.2:43117/monitor","relayWsUrl":"wss://relay.example/relay/phone/mac-2","token":"1234567890123456"}"""
        val encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(data.toByteArray())

        val pairing = PairingCodec.parse("codex-monitor://pair?data=$encoded")

        assertEquals(
            listOf("ws://192.168.1.2:43117/monitor", "wss://relay.example/relay/phone/mac-2"),
            pairing.endpoints(ConnectionPreference.AUTOMATIC).map { it.wsUrl },
        )
        assertEquals("wss://relay.example/relay/phone/mac-2", pairing.endpoints(ConnectionPreference.RELAY).single().wsUrl)
    }

    @Test
    fun staleRelayPreferenceFallsBackToLanWhenPairingHasNoRelay() {
        val pairing = PairingData(
            v = 2,
            id = "mac-lan-only",
            name = "Mac",
            wsUrl = "ws://192.168.10.19:43117/monitor",
            lanWsUrl = "ws://192.168.10.19:43117/monitor",
            token = "1234567890123456",
        )

        assertEquals(false, pairing.hasRelay())
        assertEquals(
            listOf("ws://192.168.10.19:43117/monitor"),
            pairing.endpoints(ConnectionPreference.RELAY).map { it.wsUrl },
        )
        assertEquals(
            listOf(ConnectionPreference.DIRECT),
            pairing.endpoints(ConnectionPreference.RELAY).map { it.preference },
        )
        assertEquals(
            ConnectionPreference.AUTOMATIC,
            ConnectionPreferencePolicy.resolve(pairing, ConnectionPreference.RELAY),
        )
    }

    @Test
    fun updaterPrefersCurrentLanAddressOverLegacyFallback() {
        val pairing = PairingData(
            v = 2,
            id = "mac-2",
            name = "Mac",
            wsUrl = "ws://192.168.1.18:43117/monitor",
            lanWsUrl = "ws://192.168.10.19:43117/monitor",
            relayWsUrl = "wss://relay.example.com/codex-monitor/relay/phone/mac-2",
            token = "1234567890123456",
        )

        assertEquals(
            listOf(
                "http://192.168.10.19:43118",
                "http://192.168.10.19:43117",
                "http://192.168.1.18:43118",
                "http://192.168.1.18:43117",
            ),
            UpdateEndpointPolicy.baseUrls(pairing),
        )
    }

    @Test
    fun updaterKeepsLegacySecurePairingAddressCompatible() {
        val pairing = PairingData(
            v = 1,
            id = "relay-1",
            name = "Relay",
            wsUrl = "wss://example.test/monitor",
            token = "1234567890123456",
        )

        assertEquals(listOf("https://example.test"), UpdateEndpointPolicy.baseUrls(pairing))
    }

    @Test
    fun updaterAndConnectionUseHostnameAfterLegacyLanAddress() {
        val pairing = PairingData(
            v = 2,
            id = "mac-host",
            name = "Mac",
            wsUrl = "ws://192.168.10.17:43117/monitor",
            lanWsUrl = "ws://192.168.10.17:43117/monitor",
            lanHostWsUrl = "ws://mac-mini.local:43117/monitor",
            token = "1234567890123456",
        )

        assertEquals(
            listOf(
                "ws://192.168.10.17:43117/monitor",
                "ws://mac-mini.local:43117/monitor",
            ),
            pairing.endpoints(ConnectionPreference.AUTOMATIC).map { it.wsUrl },
        )
        assertEquals(
            listOf(
                "http://192.168.10.17:43118",
                "http://192.168.10.17:43117",
                "http://mac-mini.local:43118",
                "http://mac-mini.local:43117",
            ),
            UpdateEndpointPolicy.baseUrls(pairing),
        )
        assertEquals(
            listOf(
                "http://192.168.10.17:43117",
                "http://mac-mini.local:43117",
            ),
            EvidenceEndpointPolicy.baseUrls(pairing),
        )
    }

    @Test
    fun evidenceDownloadPreservesTheRelayReverseProxyPrefix() {
        val pairing = PairingData(
            v = 2,
            id = "mac-relay",
            name = "Mac",
            wsUrl = "ws://192.168.10.19:43117/monitor",
            lanWsUrl = "ws://192.168.10.19:43117/monitor",
            relayWsUrl = "wss://relay.example.com/codex-monitor/relay/phone/mac-relay",
            token = "1234567890123456",
        )

        assertEquals(
            listOf(
                "http://192.168.10.19:43117",
                "https://relay.example.com/codex-monitor",
            ),
            EvidenceEndpointPolicy.baseUrls(pairing),
        )
    }

    @Test
    fun oldPairingCanDeriveTheMacLocalHostnameWithoutRescanning() {
        val pairing = PairingData(
            v = 1,
            id = "mac-legacy",
            name = "developer-mac.local",
            wsUrl = "ws://192.168.10.17:43117/monitor",
            token = "1234567890123456",
        )

        assertEquals(
            listOf(
                "ws://192.168.10.17:43117/monitor",
                "ws://developer-mac.local:43117/monitor",
            ),
            pairing.endpoints(ConnectionPreference.AUTOMATIC).map { it.wsUrl },
        )
        assertEquals(
            listOf(
                "http://192.168.10.17:43118",
                "http://192.168.10.17:43117",
                "http://developer-mac.local:43118",
                "http://developer-mac.local:43117",
            ),
            UpdateEndpointPolicy.baseUrls(pairing),
        )
    }

    @Test
    fun updateMigrationRewritesLegacyLanAddress() {
        val pairing = PairingData(
            v = 1,
            id = "mac-migration",
            name = "Mac",
            wsUrl = "ws://192.168.10.17:43117/monitor",
            token = "1234567890123456",
        )

        val migrated = pairing.withMigration(
            UpdateMigration(
                wsUrl = "ws://192.168.10.19:43117/monitor",
                lanWsUrl = "ws://192.168.10.19:43117/monitor",
                lanHostWsUrl = "ws://mac-mini.local:43117/monitor",
            ),
        )

        assertEquals(2, migrated.v)
        assertEquals("ws://192.168.10.19:43117/monitor", migrated.wsUrl)
        assertEquals("ws://mac-mini.local:43117/monitor", migrated.lanHostWsUrl)
        assertEquals("1234567890123456", migrated.token)
    }
}
