import Foundation

public struct PairingData: Codable, Equatable, Identifiable, Sendable {
    public let v: Int
    public let id: String
    public var name: String
    public let wsUrl: String
    public let lanWsUrl: String?
    public let lanHostWsUrl: String?
    public let relayWsUrl: String?
    public let token: String

    public init(
        v: Int,
        id: String,
        name: String,
        wsUrl: String,
        lanWsUrl: String? = nil,
        lanHostWsUrl: String? = nil,
        relayWsUrl: String? = nil,
        token: String
    ) {
        self.v = v
        self.id = id
        self.name = name
        self.wsUrl = wsUrl
        self.lanWsUrl = lanWsUrl
        self.lanHostWsUrl = lanHostWsUrl
        self.relayWsUrl = relayWsUrl
        self.token = token
    }

    public var directURLString: String? {
        directURLStrings.first
    }

    public var directURLStrings: [String] {
        var values: [String] = []
        if let lanWsUrl { values.append(lanWsUrl) }
        if let lanHostWsUrl { values.append(lanHostWsUrl) }
        if URL(string: wsUrl)?.scheme == "ws" { values.append(wsUrl) }
        var seen = Set<String>()
        return values.filter { seen.insert($0).inserted }
    }

    public var remoteURLString: String? {
        if let relayWsUrl { return relayWsUrl }
        return URL(string: wsUrl)?.scheme == "wss" ? wsUrl : nil
    }

    public func urlString(for preference: ConnectionPreference) -> String? {
        connectionCandidates(for: preference).first?.urlString
    }

    public func connectionCandidates(for preference: ConnectionPreference) -> [ConnectionEndpoint] {
        let candidates: [ConnectionEndpoint]
        switch preference {
        case .automatic:
            candidates = directURLStrings.map { ConnectionEndpoint(kind: .direct, urlString: $0) } + [
                remoteURLString.map { ConnectionEndpoint(kind: .relay, urlString: $0) },
            ].compactMap { $0 }
        case .direct:
            candidates = directURLStrings.map { ConnectionEndpoint(kind: .direct, urlString: $0) }
        case .relay:
            candidates = remoteURLString.map { [ConnectionEndpoint(kind: .relay, urlString: $0)] } ?? []
        }
        var seen = Set<String>()
        return candidates.filter { seen.insert($0.urlString).inserted }
    }
}

public struct ConnectionEndpoint: Equatable, Sendable {
    public let kind: ConnectionPreference
    public let urlString: String

    public init(kind: ConnectionPreference, urlString: String) {
        self.kind = kind
        self.urlString = urlString
    }
}

public struct GoalInfo: Codable, Equatable, Sendable {
    public let status: String
    public let objective: String

    public init(status: String, objective: String = "") {
        self.status = status
        self.objective = objective
    }
}

public struct EvidenceImage: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let mimeType: String
    public let downloadPath: String

    public init(id: String, name: String, mimeType: String, downloadPath: String) {
        self.id = id
        self.name = name
        self.mimeType = mimeType
        self.downloadPath = downloadPath
    }

    public var hasSafeDownloadAddress: Bool {
        let validPath = downloadPath.range(
            of: "^/evidence/[a-f0-9]{32}$",
            options: .regularExpression
        ) != nil
        return validPath && ["image/jpeg", "image/png", "image/webp"].contains(mimeType.lowercased())
    }
}

public struct SessionStatus: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let updatedAt: String
    public let state: String
    public let message: String
    public let goal: GoalInfo?
    public let evidence: [EvidenceImage]

    public init(
        id: String,
        title: String,
        updatedAt: String,
        state: String,
        message: String,
        goal: GoalInfo? = nil,
        evidence: [EvidenceImage] = []
    ) {
        self.id = id
        self.title = title
        self.updatedAt = updatedAt
        self.state = state
        self.message = message
        self.goal = goal
        self.evidence = evidence
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, updatedAt, state, message, goal, evidence
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        updatedAt = try container.decode(String.self, forKey: .updatedAt)
        state = try container.decode(String.self, forKey: .state)
        message = try container.decode(String.self, forKey: .message)
        goal = try container.decodeIfPresent(GoalInfo.self, forKey: .goal)
        evidence = try container.decodeIfPresent([EvidenceImage].self, forKey: .evidence) ?? []
    }
}

public struct MachineInfo: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
}

public struct WireSnapshot: Codable, Equatable, Sendable {
    public let type: String
    public let machine: MachineInfo
    public let sentAt: String
    public let sessions: [SessionStatus]
}

public struct PushRegistrationMessage: Encodable, Equatable, Sendable {
    public let type = "push_registration"
    public let platform = "ios"
    public let pushToken: String
    public let enabled: Bool
    public let silentCompletionSessionIds: [String]

    public init(pushToken: String, enabled: Bool, silentCompletionSessionIds: [String] = []) {
        self.pushToken = pushToken
        self.enabled = enabled
        self.silentCompletionSessionIds = silentCompletionSessionIds
    }
}

public struct PushReadMessage: Encodable, Equatable, Sendable {
    public let type = "push_read"
    public let platform = "ios"
    public let pushToken: String
    public let sessionId: String
    public let state: String

    public init(pushToken: String, sessionId: String, state: String) {
        self.pushToken = pushToken
        self.sessionId = sessionId
        self.state = state
    }
}

public struct PendingPushRead: Codable, Equatable, Hashable, Sendable {
    public let deviceId: String
    public let sessionId: String
    public let state: String

    public init(deviceId: String, sessionId: String, state: String) {
        self.deviceId = deviceId
        self.sessionId = sessionId
        self.state = state
    }
}

public enum PushRegistrationEndpoint {
    public static func url(for pairing: PairingData) -> URL? {
        PushEndpoint.url(for: pairing, action: "register")
    }
}

public enum PushReadEndpoint {
    public static func url(for pairing: PairingData) -> URL? {
        PushEndpoint.url(for: pairing, action: "read")
    }
}

private enum PushEndpoint {
    static func url(for pairing: PairingData, action: String) -> URL? {
        guard let remote = pairing.remoteURLString,
              var components = URLComponents(string: remote),
              components.host != nil else { return nil }
        components.scheme = components.scheme == "wss" ? "https" : "http"
        let marker = "/relay/phone/"
        guard let markerRange = components.percentEncodedPath.range(of: marker) else { return nil }
        let prefix = String(components.percentEncodedPath[..<markerRange.lowerBound])
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.percentEncodedPath = prefix.isEmpty
            ? "/push/\(action)/\(pairing.id)"
            : "/\(prefix)/push/\(action)/\(pairing.id)"
        components.queryItems = [URLQueryItem(name: "token", value: pairing.token)]
        components.fragment = nil
        return components.url
    }
}

public struct LampPushEvent: Codable, Equatable, Sendable {
    public let type: String
    public let deviceId: String
    public let deviceName: String
    public let sessionId: String
    public let sessionTitle: String
    public let fromState: String
    public let toState: String
    public let changedAt: String
    public let silent: Bool
    public let reminder: Bool?

    public var isValidTransition: Bool {
        let states = Set(["running", "blocked", "completed", "unknown"])
        return type == "lamp_changed" && !deviceId.isEmpty && !sessionId.isEmpty
            && states.contains(fromState) && states.contains(toState) && fromState != toState
    }
}

public struct GuidanceAttachment: Codable, Equatable, Sendable {
    public let name: String
    public let mimeType: String
    public let sizeBytes: Int
    public let dataBase64: String

    public init(name: String, mimeType: String, sizeBytes: Int, dataBase64: String) {
        self.name = name
        self.mimeType = mimeType
        self.sizeBytes = sizeBytes
        self.dataBase64 = dataBase64
    }
}

public struct GuidanceMessage: Encodable, Equatable, Sendable {
    public let type = "guidance"
    public let requestId: String
    public let sessionId: String
    public let text: String
    public let mode: String
    public let attachments: [GuidanceAttachment]

    public init(
        requestId: String,
        sessionId: String,
        text: String,
        mode: String,
        attachments: [GuidanceAttachment] = []
    ) {
        self.requestId = requestId
        self.sessionId = sessionId
        self.text = text
        self.mode = mode
        self.attachments = attachments
    }
}

public struct GuidanceAck: Codable, Equatable, Sendable {
    public let type: String
    public let requestId: String
    public let sessionId: String
    public let message: String
}

public struct GuidanceResult: Codable, Equatable, Sendable {
    public let type: String
    public let requestId: String
    public let sessionId: String
    public let ok: Bool
    public let message: String
}

public struct GoalCommandMessage: Encodable, Equatable, Sendable {
    public let type = "goal_command"
    public let requestId: String
    public let sessionId: String
    public let command: String
    public let confirmed: Bool

    public init(requestId: String, sessionId: String, command: String, confirmed: Bool = false) {
        self.requestId = requestId
        self.sessionId = sessionId
        self.command = command
        self.confirmed = confirmed
    }
}

public struct GoalCommandAck: Codable, Equatable, Sendable {
    public let type: String
    public let requestId: String
    public let sessionId: String
    public let message: String
}

public struct GoalCommandResult: Codable, Equatable, Sendable {
    public let type: String
    public let requestId: String
    public let sessionId: String
    public let command: String
    public let ok: Bool
    public let message: String

    private enum CodingKeys: String, CodingKey {
        case type, requestId, sessionId, command, ok, message
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        requestId = try container.decode(String.self, forKey: .requestId)
        sessionId = try container.decode(String.self, forKey: .sessionId)
        command = try container.decodeIfPresent(String.self, forKey: .command) ?? ""
        ok = try container.decode(Bool.self, forKey: .ok)
        message = try container.decode(String.self, forKey: .message)
    }
}

public struct ClientInfoMessage: Encodable, Equatable, Sendable {
    public let type = "client_info"
    public let platform = "ios"
    public let appVersion: String
    public let versionCode: Int
    public let statusProtocolVersion: Int
    public let releaseNotes: [String]

    public init(
        appVersion: String,
        versionCode: Int,
        statusProtocolVersion: Int,
        releaseNotes: [String]
    ) {
        self.appVersion = appVersion
        self.versionCode = versionCode
        self.statusProtocolVersion = statusProtocolVersion
        self.releaseNotes = releaseNotes
    }
}

public enum GuidanceMode: String, CaseIterable, Codable, Sendable {
    case steer
    case queue
}

public enum ConnectionPreference: String, CaseIterable, Codable, Sendable {
    case automatic
    case direct
    case relay

    public var label: String {
        switch self {
        case .automatic: return "自动"
        case .direct: return "局域网直连"
        case .relay: return "远程中继"
        }
    }
}

public enum ResponseValidationPolicy {
    public static func guidanceMatches(expectedSessionID: String, responseSessionID: String) -> Bool {
        expectedSessionID == responseSessionID
    }

    public static func goalMatches(
        expectedSessionID: String,
        responseSessionID: String,
        expectedCommand: String,
        responseCommand: String
    ) -> Bool {
        responseSessionID == expectedSessionID &&
            (responseCommand.isEmpty || responseCommand == expectedCommand)
    }
}

public enum SessionLamp: String, Equatable, Sendable {
    case running
    case blocked
    case completed
    case unknown

    public init(state: String, connected: Bool) {
        guard connected else {
            self = .unknown
            return
        }
        self = SessionLamp(rawValue: state) ?? .unknown
    }

    public var label: String {
        switch self {
        case .running: return "运行中"
        case .blocked: return "受阻"
        case .completed: return "已完成"
        case .unknown: return "未知"
        }
    }

    public var symbol: String {
        switch self {
        case .running: return "🟢"
        case .blocked: return "🔴"
        case .completed: return "🔵"
        case .unknown: return "⚫"
        }
    }
}

public enum JarvisNotificationPolicy {
    public static func isSilentCompletion(
        isJarvis: Bool,
        previousState: String?,
        currentState: String
    ) -> Bool {
        isJarvis && previousState == "running" && currentState == "completed"
    }
}

public enum PairingCodecError: LocalizedError, Equatable {
    case invalidScheme
    case missingData
    case invalidEncoding
    case unsupportedVersion
    case invalidAddress
    case invalidIdentity

    public var errorDescription: String? {
        switch self {
        case .invalidScheme: return "这不是 Codex Monitor 配对码"
        case .missingData: return "配对码缺少连接信息"
        case .invalidEncoding: return "配对码内容损坏"
        case .unsupportedVersion: return "不支持此配对码版本"
        case .invalidAddress: return "连接地址无效"
        case .invalidIdentity: return "配对信息无效"
        }
    }
}

public enum PairingCodec {
    public static func parse(_ value: String) throws -> PairingData {
        guard let components = URLComponents(string: value),
              components.scheme == "codex-monitor",
              components.host == "pair" else {
            throw PairingCodecError.invalidScheme
        }
        guard let encoded = components.queryItems?.first(where: { $0.name == "data" })?.value else {
            throw PairingCodecError.missingData
        }
        var base64 = encoded.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = base64.count % 4
        if remainder > 0 { base64 += String(repeating: "=", count: 4 - remainder) }
        guard let data = Data(base64Encoded: base64),
              let pairing = try? JSONDecoder().decode(PairingData.self, from: data) else {
            throw PairingCodecError.invalidEncoding
        }
        guard pairing.v == 1 || pairing.v == 2 else { throw PairingCodecError.unsupportedVersion }
        let addresses = [pairing.wsUrl, pairing.lanWsUrl, pairing.lanHostWsUrl, pairing.relayWsUrl].compactMap { $0 }
        guard !addresses.isEmpty, addresses.allSatisfy({ value in
            guard let socketURL = URL(string: value) else { return false }
            return (socketURL.scheme == "ws" || socketURL.scheme == "wss") && socketURL.host != nil
        }) else {
            throw PairingCodecError.invalidAddress
        }
        guard !pairing.id.isEmpty, pairing.token.count >= 16 else {
            throw PairingCodecError.invalidIdentity
        }
        return pairing
    }
}
