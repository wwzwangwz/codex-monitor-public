import Testing
import Foundation
@testable import CodexMonitorCore

@Suite("Codex Monitor protocol")
struct ProtocolTests {
    @Test func responseValidationRejectsCrossSessionAndWrongGoalCommandResults() {
        #expect(ResponseValidationPolicy.guidanceMatches(expectedSessionID: "s1", responseSessionID: "s1"))
        #expect(!ResponseValidationPolicy.guidanceMatches(expectedSessionID: "s1", responseSessionID: "s2"))
        #expect(ResponseValidationPolicy.goalMatches(
            expectedSessionID: "s1", responseSessionID: "s1", expectedCommand: "resume", responseCommand: "resume"
        ))
        #expect(ResponseValidationPolicy.goalMatches(
            expectedSessionID: "s1", responseSessionID: "s1", expectedCommand: "resume", responseCommand: ""
        ))
        #expect(!ResponseValidationPolicy.goalMatches(
            expectedSessionID: "s1", responseSessionID: "s2", expectedCommand: "resume", responseCommand: "resume"
        ))
        #expect(!ResponseValidationPolicy.goalMatches(
            expectedSessionID: "s1", responseSessionID: "s1", expectedCommand: "resume", responseCommand: "delete"
        ))
    }

    @Test func parsesLANPairingCode() throws {
        let payload = #"{"v":1,"id":"mac-1","name":"Studio Mac","wsUrl":"ws://192.168.1.8:43117/monitor","token":"1234567890123456"}"#
        let data = Data(payload.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let pairing = try PairingCodec.parse("codex-monitor://pair?data=\(data)")
        #expect(pairing.id == "mac-1")
        #expect(pairing.wsUrl == "ws://192.168.1.8:43117/monitor")
    }

    @Test func acceptsInternetRelayWSSPairingCode() throws {
        let payload = #"{"v":1,"id":"win-1","name":"Windows","wsUrl":"wss://relay.example.com/relay/phone/win-1","token":"1234567890123456"}"#
        let data = Data(payload.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        #expect(try PairingCodec.parse("codex-monitor://pair?data=\(data)").wsUrl == "wss://relay.example.com/relay/phone/win-1")
    }

    @Test func versionTwoCanKeepLANAndRelayIndependent() throws {
        let pairing = PairingData(
            v: 2,
            id: "device-1",
            name: "Studio",
            wsUrl: "ws://192.168.1.8:43117/monitor",
            lanWsUrl: "ws://192.168.1.8:43117/monitor",
            relayWsUrl: "wss://relay.example.com/relay/phone/device-1",
            token: "1234567890123456"
        )
        #expect(pairing.urlString(for: .direct) == pairing.lanWsUrl)
        #expect(pairing.urlString(for: .relay) == pairing.relayWsUrl)
        #expect(pairing.urlString(for: .automatic) == pairing.lanWsUrl)
    }

    @Test func automaticConnectionTriesLANBeforeRelay() {
        let pairing = PairingData(
            v: 2,
            id: "mac-1",
            name: "Studio",
            wsUrl: "ws://192.168.1.2:43117/monitor",
            lanWsUrl: "ws://192.168.1.2:43117/monitor",
            relayWsUrl: "wss://relay.example/relay/phone/mac-1",
            token: "1234567890123456"
        )

        let candidates = pairing.connectionCandidates(for: .automatic)
        #expect(candidates.map(\.kind) == [.direct, .relay])
        #expect(candidates.map(\.urlString) == [
            "ws://192.168.1.2:43117/monitor",
            "wss://relay.example/relay/phone/mac-1",
        ])
    }

    @Test func automaticConnectionUsesHostnameAfterLegacyIP() {
        let pairing = PairingData(
            v: 2,
            id: "mac-host",
            name: "Studio",
            wsUrl: "ws://192.168.10.17:43117/monitor",
            lanWsUrl: "ws://192.168.10.17:43117/monitor",
            lanHostWsUrl: "ws://mac-mini.local:43117/monitor",
            token: "1234567890123456"
        )

        #expect(pairing.directURLStrings == [
            "ws://192.168.10.17:43117/monitor",
            "ws://mac-mini.local:43117/monitor",
        ])
        #expect(pairing.connectionCandidates(for: .automatic).map(\.urlString) == pairing.directURLStrings)
        #expect(pairing.connectionCandidates(for: .direct).map(\.urlString) == pairing.directURLStrings)
    }

    @Test func rejectsUnrelatedQRCode() {
        #expect(throws: PairingCodecError.invalidScheme) {
            try PairingCodec.parse("https://example.com")
        }
    }

    @Test func guidanceAlwaysContainsModeAndType() throws {
        let value = GuidanceMessage(requestId: "r1", sessionId: "s1", text: "继续", mode: "steer")
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any]
        #expect(object?["type"] as? String == "guidance")
        #expect(object?["mode"] as? String == "steer")
        #expect((object?["attachments"] as? [Any])?.isEmpty == true)
    }

    @Test func guidanceEncodesScreenshotAttachmentWithDeclaredSize() throws {
        let data = Data("image".utf8)
        let attachment = GuidanceAttachment(
            name: "problem.jpg",
            mimeType: "image/jpeg",
            sizeBytes: data.count,
            dataBase64: data.base64EncodedString()
        )
        let value = GuidanceMessage(
            requestId: "r2",
            sessionId: "s2",
            text: "请看截图",
            mode: "steer",
            attachments: [attachment]
        )
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any]
        let encoded = (object?["attachments"] as? [[String: Any]])?.first
        #expect(encoded?["name"] as? String == "problem.jpg")
        #expect(encoded?["sizeBytes"] as? Int == data.count)
        #expect(encoded?["dataBase64"] as? String == data.base64EncodedString())
    }

    @Test func decodesOptionalGoalAndEvidenceWithoutBreakingLegacySnapshot() throws {
        let legacy = #"{"id":"s1","title":"旧会话","updatedAt":"2026-07-25T00:00:00Z","state":"running","message":"继续"}"#
        let legacySession = try JSONDecoder().decode(SessionStatus.self, from: Data(legacy.utf8))
        #expect(legacySession.goal == nil)
        #expect(legacySession.evidence.isEmpty)

        let current = #"{"id":"s2","title":"新会话","updatedAt":"2026-07-25T00:00:00Z","state":"blocked","message":"已受阻","goal":{"status":"blocked","objective":"完成修复"},"evidence":[{"id":"0123456789abcdef0123456789abcdef","name":"result.png","mimeType":"image/png","downloadPath":"/evidence/0123456789abcdef0123456789abcdef"}]}"#
        let currentSession = try JSONDecoder().decode(SessionStatus.self, from: Data(current.utf8))
        #expect(currentSession.goal?.status == "blocked")
        #expect(currentSession.evidence.first?.downloadPath.hasPrefix("/evidence/") == true)
    }

    @Test func acceptsLegacyGoalResultWithoutCommand() throws {
        let legacy = #"{"type":"goal_command_result","requestId":"r1","sessionId":"s1","ok":false,"message":"不支持"}"#
        let result = try JSONDecoder().decode(GoalCommandResult.self, from: Data(legacy.utf8))
        #expect(result.command.isEmpty)
        #expect(result.ok == false)
    }

    @Test func evidenceDownloadAddressIsStrictlyWhitelisted() {
        let safe = EvidenceImage(
            id: "0123456789abcdef0123456789abcdef",
            name: "result.png",
            mimeType: "image/png",
            downloadPath: "/evidence/0123456789abcdef0123456789abcdef"
        )
        let unsafePath = EvidenceImage(
            id: "bad",
            name: "private.txt",
            mimeType: "image/png",
            downloadPath: "/evidence/../../private.txt"
        )
        let unsafeType = EvidenceImage(
            id: safe.id,
            name: "result.svg",
            mimeType: "image/svg+xml",
            downloadPath: safe.downloadPath
        )
        #expect(safe.hasSafeDownloadAddress)
        #expect(!unsafePath.hasSafeDownloadAddress)
        #expect(!unsafeType.hasSafeDownloadAddress)
    }

    @Test func disconnectedSessionIsAlwaysUnknown() {
        #expect(SessionLamp(state: "running", connected: false) == .unknown)
        #expect(SessionLamp(state: "blocked", connected: true) == .blocked)
    }

    @Test func buildsLANIndependentAPNsRegistrationEndpoint() throws {
        let pairing = PairingData(
            v: 2,
            id: "00000000-0000-4000-8000-000000000001",
            name: "Primary Mac",
            wsUrl: "ws://192.168.1.2:43117/monitor",
            lanWsUrl: "ws://192.168.1.2:43117/monitor",
            relayWsUrl: "wss://relay.example/relay/phone/00000000-0000-4000-8000-000000000001",
            token: "0123456789abcdef0123456789abcdef"
        )
        #expect(PushRegistrationEndpoint.url(for: pairing)?.absoluteString ==
            "https://relay.example/push/register/00000000-0000-4000-8000-000000000001?token=0123456789abcdef0123456789abcdef")
        #expect(PushReadEndpoint.url(for: pairing)?.absoluteString ==
            "https://relay.example/push/read/00000000-0000-4000-8000-000000000001?token=0123456789abcdef0123456789abcdef")
        let encoded = try JSONEncoder().encode(PushRegistrationMessage(pushToken: "apns-token", enabled: true))
        let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        #expect(object["type"] as? String == "push_registration")
        #expect(object["platform"] as? String == "ios")
        let read = try JSONEncoder().encode(PushReadMessage(pushToken: "apns-token", sessionId: "s1", state: "blocked"))
        let readObject = try #require(JSONSerialization.jsonObject(with: read) as? [String: Any])
        #expect(readObject["type"] as? String == "push_read")
        #expect(readObject["sessionId"] as? String == "s1")
        #expect(readObject["state"] as? String == "blocked")
        let pending = PendingPushRead(deviceId: pairing.id, sessionId: "s1", state: "blocked")
        let restored = try JSONDecoder().decode(
            Set<PendingPushRead>.self,
            from: JSONEncoder().encode(Set([pending]))
        )
        #expect(restored == Set([pending]))
    }

    @Test func preservesSharedServerPathPrefixForPushEndpoints() {
        let pairing = PairingData(
            v: 2,
            id: "00000000-0000-4000-8000-000000000001",
            name: "Primary Mac",
            wsUrl: "ws://192.168.1.2:43117/monitor",
            lanWsUrl: "ws://192.168.1.2:43117/monitor",
            relayWsUrl: "wss://relay.example.com/codex-monitor/relay/phone/00000000-0000-4000-8000-000000000001",
            token: "0123456789abcdef0123456789abcdef"
        )
        #expect(PushRegistrationEndpoint.url(for: pairing)?.absoluteString ==
            "https://relay.example.com/codex-monitor/push/register/00000000-0000-4000-8000-000000000001?token=0123456789abcdef0123456789abcdef")
        #expect(PushReadEndpoint.url(for: pairing)?.absoluteString ==
            "https://relay.example.com/codex-monitor/push/read/00000000-0000-4000-8000-000000000001?token=0123456789abcdef0123456789abcdef")
    }
}
