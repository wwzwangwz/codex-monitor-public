import Foundation
import Combine
import UIKit
import UserNotifications

struct DeviceViewState: Identifiable, Equatable {
    var pairing: PairingData
    var connected = false
    var activeConnection: ConnectionPreference?
    var lastSeen: Date?
    var sessions: [SessionStatus] = []
    var newSessionIDs: Set<String> = []
    var jarvisSessionIDs: Set<String> = []
    var id: String { pairing.id }
}

struct GuidanceUIState: Equatable {
    var sending: Bool
    var ok: Bool?
    var message: String
}

struct GoalCommandUIState: Equatable {
    var sending: Bool
    var ok: Bool?
    var message: String
}

private struct PendingGoalRequest {
    let key: String
    let sessionID: String
    let command: String
}

@MainActor
final class MonitorController: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let appVersion = "0.1.9"
    static let statusProtocolVersion = 7
    static let releaseNotes = [
        "0.1.9: iPhone 增加持久的贾维斯健康管家标记、置顶和静默巡检完成提醒，与 Android 行为对齐",
        "0.1.8: 局域网二维码同时支持当前 IP 和 Mac 主机名；IP 变化时自动尝试主机名，健康探测也会遍历局域网备用地址",
        "0.1.7: APNs 未读灯色每 60 秒重复提醒；点开会话的已读确认断网时本地排队，下次启动或注册推送后自动重试",
        "0.1.6: 发送和 Goal 操作在连接恢复后自动续发；支持最多 10 张截图同一次提交，文字发送最终失败时自动复制到剪贴板",
        "0.1.5: 兼容 Goal 控制协议和重要证据图片；发送后可恢复当前会话最近一条草稿",
        "0.1.4: 未点击的 NEW 持续闪烁，并每 60 秒再次播放提示音，点击会话后停止重复提醒",
        "0.1.3: 灯色变化在前台只播放提示音并标记 NEW，不弹横幅；后台仍以声音和横幅提醒",
        "0.1.2: 新增监控总开关；关闭后保留配对但停止连接、重连、通知和引导发送",
        "0.1.1: 补齐相机与局域网权限；自动连接可在局域网和远程端点间切换，并显示当前连接方式",
        "0.1.0: 支持扫码连接多台 Mac/Windows、四色状态灯、NEW、状态变化通知和原生 Steer/Queue",
        "连接协议同时接受局域网 ws:// 与未来公网中继 wss://，不保存会话历史",
    ]

    @Published private(set) var devices: [DeviceViewState] = []
    @Published private(set) var guidanceStatus: [String: GuidanceUIState] = [:]
    @Published private(set) var goalCommandStatus: [String: GoalCommandUIState] = [:]
    @Published var templates: [String] = []
    @Published private(set) var monitoringEnabled = true
    @Published private(set) var connectionPreferences: [String: ConnectionPreference] = [:]
    @Published var pairingError: String?

    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private var tasks: [String: URLSessionWebSocketTask] = [:]
    private var sessions: [String: URLSession] = [:]
    private var reconnectWork: [String: Task<Void, Never>] = [:]
    private var offlineConfirmationWork: [String: Task<Void, Never>] = [:]
    private var guidanceRequests: [String: String] = [:]
    private var guidanceRequestSessions: [String: String] = [:]
    private var guidanceRequestTexts: [String: String] = [:]
    private var guidanceTimeoutWork: [String: Task<Void, Never>] = [:]
    private var goalCommandRequests: [String: PendingGoalRequest] = [:]
    private var goalCommandTimeoutWork: [String: Task<Void, Never>] = [:]
    private var lastSentGuidance: (key: String, text: String)?
    private var endpointIndexes: [String: Int] = [:]
    private var activeEndpoints: [String: ConnectionEndpoint] = [:]
    private var staleTimer: Timer?
    private var unreadReminderTimer: Timer?
    private var lastUnreadReminder = Date.distantPast
    private var started = false
    private var appActive = true
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var silentUnreadSessionIDs: Set<String> = []

    private let pairingsKey = "paired_devices_v1"
    private let templatesKey = "guidance_templates_v1"
    private let connectionPreferencesKey = "connection_preferences_v1"
    private let monitoringEnabledKey = "monitoring_enabled_v1"
    private let unreadSessionIDsKey = "unread_session_ids_v1"
    private let silentUnreadSessionIDsKey = "silent_unread_session_ids_v1"
    private let jarvisSessionIDsKey = "jarvis_session_ids_v1"
    private let pendingPushReadsKey = "pending_push_reads_v1"
    private let maxEvidenceBytes = 20 * 1024 * 1024
    private let defaultTemplates = [
        "继续执行当前任务。",
        "使用 Goal 目标继续执行，在目标完成前持续推进。",
    ]

    func start() {
        guard !started else { return }
        started = true
        UNUserNotificationCenter.current().delegate = self
        NotificationCenter.default.addObserver(self, selector: #selector(receivedPushToken(_:)), name: .codexPushToken, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(receivedLampPush(_:)), name: .codexLampPush, object: nil)
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        loadPreferences()
        consumePendingLampPushes()
        registerSystemPush(enabled: monitoringEnabled)
        if monitoringEnabled { connectAll() }
        staleTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.checkStaleConnections() }
        }
        unreadReminderTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.checkUnreadReminder() }
        }
    }

    func setAppActive(_ active: Bool) {
        appActive = active
        if active {
            endBackgroundTask()
            if monitoringEnabled { connectAll() }
        } else if monitoringEnabled {
            beginShortBackgroundWindow()
        }
    }

    func setMonitoringEnabled(_ enabled: Bool) {
        guard monitoringEnabled != enabled else { return }
        monitoringEnabled = enabled
        UserDefaults.standard.set(enabled, forKey: monitoringEnabledKey)
        if enabled {
            registerSystemPush(enabled: true)
            connectAll()
            return
        }
        registerSystemPush(enabled: false)
        endBackgroundTask()
        for device in devices {
            disconnect(device.id, remove: false)
        }
        for index in devices.indices {
            devices[index].connected = false
            devices[index].activeConnection = nil
        }
        guidanceStatus = [:]
        goalCommandStatus = [:]
        guidanceTimeoutWork.values.forEach { $0.cancel() }
        guidanceTimeoutWork = [:]
        guidanceRequests = [:]
        guidanceRequestSessions = [:]
        guidanceRequestTexts = [:]
        goalCommandTimeoutWork.values.forEach { $0.cancel() }
        goalCommandTimeoutWork = [:]
        goalCommandRequests = [:]
    }

    func addPairing(qrValue: String) {
        do {
            let pairing = try PairingCodec.parse(qrValue)
            pairingError = nil
            if let previous = devices.first(where: { $0.id == pairing.id })?.pairing,
               previous.remoteURLString != pairing.remoteURLString {
                registerSystemPush(enabled: false, pairings: [previous])
            }
            disconnect(pairing.id, remove: false)
            if let index = devices.firstIndex(where: { $0.id == pairing.id }) {
                devices[index].pairing = pairing
            } else {
                devices.append(DeviceViewState(pairing: pairing))
            }
            devices.sort { $0.pairing.name.localizedCaseInsensitiveCompare($1.pairing.name) == .orderedAscending }
            persistPairings()
            registerSystemPush(enabled: monitoringEnabled, pairings: [pairing])
            if monitoringEnabled { connect(pairing) }
        } catch {
            pairingError = error.localizedDescription
        }
    }

    func disconnect(_ id: String, remove: Bool = true) {
        if remove, let pairing = devices.first(where: { $0.id == id })?.pairing {
            registerSystemPush(enabled: false, pairings: [pairing])
        }
        reconnectWork.removeValue(forKey: id)?.cancel()
        offlineConfirmationWork.removeValue(forKey: id)?.cancel()
        tasks.removeValue(forKey: id)?.cancel(with: .normalClosure, reason: nil)
        sessions.removeValue(forKey: id)?.invalidateAndCancel()
        endpointIndexes.removeValue(forKey: id)
        activeEndpoints.removeValue(forKey: id)
        if remove {
            devices.removeAll { $0.id == id }
            removePendingPushReads(deviceID: id)
            persistPairings()
            persistUnreadSessionIDs()
            persistJarvisSessionIDs()
        }
    }

    func clearNew(deviceID: String, sessionID: String) {
        guard let index = devices.firstIndex(where: { $0.id == deviceID }) else { return }
        if let state = devices[index].sessions.first(where: { $0.id == sessionID })?.state {
            acknowledgePushRead(pairing: devices[index].pairing, sessionID: sessionID, state: state)
        }
        devices[index].newSessionIDs.remove(sessionID)
        persistUnreadSessionIDs()
    }

    func isJarvisSession(deviceID: String, sessionID: String) -> Bool {
        devices.first(where: { $0.id == deviceID })?.jarvisSessionIDs.contains(sessionID) == true
    }

    func setJarvisSession(deviceID: String, sessionID: String, enabled: Bool) {
        guard let index = devices.firstIndex(where: { $0.id == deviceID }),
              devices[index].sessions.contains(where: { $0.id == sessionID }) else { return }
        if enabled {
            devices[index].jarvisSessionIDs.insert(sessionID)
        } else {
            devices[index].jarvisSessionIDs.remove(sessionID)
        }
        persistJarvisSessionIDs()
        if let pairing = devices[index].pairing {
            registerSystemPush(enabled: monitoringEnabled, pairings: [pairing])
        }
    }

    func connectionPreference(for deviceID: String) -> ConnectionPreference {
        connectionPreferences[deviceID] ?? .automatic
    }

    func setConnectionPreference(_ preference: ConnectionPreference, deviceID: String) {
        guard let index = devices.firstIndex(where: { $0.id == deviceID }) else { return }
        let pairing = devices[index].pairing
        guard pairing.urlString(for: preference) != nil else { return }
        connectionPreferences[deviceID] = preference
        if let data = try? encoder.encode(connectionPreferences) {
            UserDefaults.standard.set(data, forKey: connectionPreferencesKey)
        }
        disconnect(deviceID, remove: false)
        devices[index].connected = false
        devices[index].activeConnection = nil
        connect(pairing)
    }

    func saveTemplates(_ values: [String]) {
        let normalized = Array(values.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }.uniqued().prefix(8))
        templates = normalized.isEmpty ? defaultTemplates : normalized
        if let data = try? encoder.encode(templates) {
            UserDefaults.standard.set(data, forKey: templatesKey)
        }
    }

    @discardableResult
    func sendGuidance(
        deviceID: String,
        sessionID: String,
        text: String,
        mode: GuidanceMode,
        attachments: [GuidanceAttachment] = []
    ) -> Bool {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = guidanceKey(deviceID, sessionID)
        guard monitoringEnabled else {
            guidanceStatus[key] = GuidanceUIState(sending: false, ok: false, message: "监控已关闭，请先打开总开关")
            return false
        }
        guard (!value.isEmpty || !attachments.isEmpty), value.count <= 2000 else {
            guidanceStatus[key] = GuidanceUIState(sending: false, ok: false, message: "请输入消息或选择图片，文字不能超过 2000 字")
            return false
        }
        let requestID = UUID().uuidString
        let message = GuidanceMessage(
            requestId: requestID,
            sessionId: sessionID,
            text: value,
            mode: mode.rawValue,
            attachments: attachments,
        )
        guard let data = try? encoder.encode(message), let json = String(data: data, encoding: .utf8) else { return false }
        guidanceRequests[requestID] = key
        guidanceRequestSessions[requestID] = sessionID
        guidanceRequestTexts[requestID] = value
        lastSentGuidance = (key, value)
        guidanceStatus[key] = GuidanceUIState(sending: true, ok: nil, message: "正在确认电脑连接")
        Task {
            guard let task = await waitForConnectedTask(deviceID: deviceID) else {
                finishGuidanceFailure(requestID: requestID, reason: "连接恢复超时，请确认电脑端 Monitor 在线后重试")
                return
            }
            do {
                try await task.send(.string(json))
                guidanceStatus[key] = GuidanceUIState(sending: true, ok: nil, message: "正在交给电脑端 Codex")
                scheduleGuidanceTimeout(
                    requestID: requestID,
                    seconds: 15,
                    reason: "电脑端 15 秒未确认收到",
                )
            } catch {
                finishGuidanceFailure(requestID: requestID, reason: "发送失败：\(error.localizedDescription)")
            }
        }
        return true
    }

    func lastGuidance(deviceID: String, sessionID: String) -> String? {
        let key = guidanceKey(deviceID, sessionID)
        return lastSentGuidance?.key == key ? lastSentGuidance?.text : nil
    }

    @discardableResult
    func sendGoalCommand(deviceID: String, sessionID: String, command: String, confirmed: Bool) -> Bool {
        let key = guidanceKey(deviceID, sessionID)
        guard monitoringEnabled else {
            goalCommandStatus[key] = GoalCommandUIState(sending: false, ok: false, message: "监控已关闭，请先打开总开关")
            return false
        }
        guard command == "resume" || command == "delete" else {
            goalCommandStatus[key] = GoalCommandUIState(sending: false, ok: false, message: "Goal 操作无效")
            return false
        }
        guard command != "delete" || confirmed else {
            goalCommandStatus[key] = GoalCommandUIState(sending: false, ok: false, message: "删除 Goal 需要确认")
            return false
        }
        guard let current = session(deviceID: deviceID, sessionID: sessionID), current.goal != nil else {
            goalCommandStatus[key] = GoalCommandUIState(sending: false, ok: false, message: "该会话没有可操作的 Goal")
            return false
        }
        if command == "resume" {
            let allowed = ["blocked", "usage_limited", "budget_limited"]
            guard current.state != "running", let status = current.goal?.status, allowed.contains(status) else {
                goalCommandStatus[key] = GoalCommandUIState(sending: false, ok: false, message: "Goal 仍在运行或未明确受阻，不能重启")
                return false
            }
        }
        let requestID = UUID().uuidString
        let message = GoalCommandMessage(requestId: requestID, sessionId: sessionID, command: command, confirmed: confirmed)
        guard let data = try? encoder.encode(message), let json = String(data: data, encoding: .utf8) else {
            goalCommandStatus[key] = GoalCommandUIState(sending: false, ok: false, message: "Goal 请求编码失败")
            return false
        }
        goalCommandRequests[requestID] = PendingGoalRequest(key: key, sessionID: sessionID, command: command)
        goalCommandStatus[key] = GoalCommandUIState(sending: true, ok: nil, message: "正在确认电脑连接")
        Task {
            guard let task = await waitForConnectedTask(deviceID: deviceID) else {
                finishGoalFailure(requestID: requestID, reason: "连接恢复超时，请确认电脑端 Monitor 在线后重试")
                return
            }
            do {
                try await task.send(.string(json))
                goalCommandStatus[key] = GoalCommandUIState(sending: true, ok: nil, message: "正在交给电脑端处理 Goal")
                scheduleGoalTimeout(requestID: requestID, seconds: 15, reason: "电脑端 15 秒未确认收到 Goal 操作")
            } catch {
                finishGoalFailure(requestID: requestID, reason: "Goal 操作发送失败：\(error.localizedDescription)")
            }
        }
        return true
    }

    func device(_ id: String) -> DeviceViewState? {
        devices.first { $0.id == id }
    }

    func session(deviceID: String, sessionID: String) -> SessionStatus? {
        device(deviceID)?.sessions.first { $0.id == sessionID }
    }

    func loadEvidence(deviceID: String, evidence: EvidenceImage) async throws -> UIImage {
        guard evidence.hasSafeDownloadAddress,
        let device = device(deviceID),
        let endpoint = activeEndpoints[deviceID] ?? device.pairing.connectionCandidates(for: connectionPreference(for: deviceID)).first,
        var components = endpoint.flatMap({ URLComponents(string: $0.urlString) }) else {
            throw EvidenceLoadError.invalidAddress
        }
        components.scheme = components.scheme == "wss" ? "https" : "http"
        components.path = evidence.downloadPath
        var query = components.queryItems ?? []
        query.removeAll { $0.name == "token" }
        query.append(URLQueryItem(name: "token", value: device.pairing.token))
        components.queryItems = query
        guard let url = components.url else { throw EvidenceLoadError.invalidAddress }

        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 20
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw EvidenceLoadError.downloadFailed
        }
        let contentType = http.value(forHTTPHeaderField: "Content-Type")?.split(separator: ";").first?.lowercased()
        guard contentType == evidence.mimeType.lowercased(), data.count <= maxEvidenceBytes,
              let image = UIImage(data: data) else {
            throw EvidenceLoadError.invalidImage
        }
        return image
    }

    private func waitForConnectedTask(deviceID: String) async -> URLSessionWebSocketTask? {
        guard let pairing = devices.first(where: { $0.id == deviceID })?.pairing else { return nil }
        if tasks[deviceID] == nil { connect(pairing) }
        for _ in 0..<20 {
            guard !Task.isCancelled, monitoringEnabled else { return nil }
            if let task = tasks[deviceID], let device = devices.first(where: { $0.id == deviceID }), device.connected {
                if let lastSeen = device.lastSeen, Date().timeIntervalSince(lastSeen) < 20 {
                    return task
                }
                task.cancel(with: .goingAway, reason: nil)
                handleTransportFailure(pairing: pairing, task: task)
            }
            try? await Task.sleep(for: .milliseconds(500))
            if tasks[deviceID] == nil { connect(pairing) }
        }
        return nil
    }

    private func scheduleGuidanceTimeout(requestID: String, seconds: Double, reason: String) {
        guidanceTimeoutWork.removeValue(forKey: requestID)?.cancel()
        guidanceTimeoutWork[requestID] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            self?.finishGuidanceFailure(requestID: requestID, reason: reason)
        }
    }

    private func finishGuidanceFailure(requestID: String, reason: String) {
        guidanceTimeoutWork.removeValue(forKey: requestID)?.cancel()
        guard let key = guidanceRequests.removeValue(forKey: requestID) else { return }
        guidanceRequestSessions.removeValue(forKey: requestID)
        let text = guidanceRequestTexts.removeValue(forKey: requestID)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if text.isEmpty {
            guidanceStatus[key] = GuidanceUIState(sending: false, ok: false, message: reason)
        } else {
            UIPasteboard.general.string = text
            guidanceStatus[key] = GuidanceUIState(
                sending: false,
                ok: false,
                message: "\(reason)；本次文字已复制到剪贴板",
            )
        }
    }

    private func scheduleGoalTimeout(requestID: String, seconds: Double, reason: String) {
        goalCommandTimeoutWork.removeValue(forKey: requestID)?.cancel()
        goalCommandTimeoutWork[requestID] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            self?.finishGoalFailure(requestID: requestID, reason: reason)
        }
    }

    private func finishGoalFailure(requestID: String, reason: String) {
        goalCommandTimeoutWork.removeValue(forKey: requestID)?.cancel()
        guard let request = goalCommandRequests.removeValue(forKey: requestID) else { return }
        goalCommandStatus[request.key] = GoalCommandUIState(sending: false, ok: false, message: reason)
    }

    private func connectAll() {
        for pairing in devices.map(\.pairing) { connect(pairing) }
    }

    private func connect(_ pairing: PairingData) {
        guard monitoringEnabled else { return }
        let preference = connectionPreference(for: pairing.id)
        let candidates = pairing.connectionCandidates(for: preference)
        let index = min(endpointIndexes[pairing.id] ?? 0, max(0, candidates.count - 1))
        guard let endpoint = candidates.indices.contains(index) ? candidates[index] : nil else { return }
        activeEndpoints[pairing.id] = endpoint
        let session = URLSession(configuration: .default)
        sessions[pairing.id] = session
        let task = session.webSocketTask(with: URL(string: endpoint.urlString)!)
        task.resume()
        tasks[pairing.id] = task
        receiveNext(pairing: pairing, task: task)
    }

    private func receiveNext(pairing: PairingData, task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor in self?.handleReceive(result: result, pairing: pairing, task: task) }
        }
    }

    private func handleReceive(result: Result<URLSessionWebSocketTask.Message, Error>, pairing: PairingData, task: URLSessionWebSocketTask) {
        switch result {
        case .success(let message):
            switch message {
            case .string(let text):
                handleMessage(text: text, pairing: pairing)
            case .data(let data):
                if let text = String(data: data, encoding: .utf8) {
                    handleMessage(text: text, pairing: pairing)
                }
            @unknown default: break
            }
            if tasks[pairing.id] === task {
                receiveNext(pairing: pairing, task: task)
            }
        case .failure:
            handleTransportFailure(pairing: pairing, task: task)
        }
    }

    private func handleMessage(text: String, pairing: PairingData) {
        guard let data = text.data(using: .utf8),
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = body["type"] as? String else { return }

        if ["goal_command_ack", "goal_command_result", "guidance_ack", "guidance_result"].contains(type) {
            if type == "goal_command_ack", let ack = try? decoder.decode(GoalCommandAck.self, from: data) {
                if let request = goalCommandRequests[ack.requestId] {
                    guard ResponseValidationPolicy.guidanceMatches(
                        expectedSessionID: request.sessionID,
                        responseSessionID: ack.sessionId
                    ) else {
                        finishGoalFailure(requestID: ack.requestId, reason: "电脑端返回了不匹配的 Goal 会话确认，消息未确认")
                        return
                    }
                    goalCommandStatus[request.key] = GoalCommandUIState(sending: true, ok: nil, message: ack.message)
                    scheduleGoalTimeout(
                        requestID: ack.requestId,
                        seconds: 30,
                        reason: "电脑端已收到，但 30 秒未返回 Goal 最终执行结果",
                    )
                }
                return
            }
            if type == "goal_command_result", let result = try? decoder.decode(GoalCommandResult.self, from: data) {
                if let request = goalCommandRequests[result.requestId] {
                    guard ResponseValidationPolicy.goalMatches(
                        expectedSessionID: request.sessionID,
                        responseSessionID: result.sessionId,
                        expectedCommand: request.command,
                        responseCommand: result.command
                    ) else {
                        finishGoalFailure(requestID: result.requestId, reason: "电脑端返回了不匹配的 Goal 操作结果，消息未确认")
                        return
                    }
                    goalCommandRequests.removeValue(forKey: result.requestId)
                    goalCommandTimeoutWork.removeValue(forKey: result.requestId)?.cancel()
                    goalCommandStatus[request.key] = GoalCommandUIState(sending: false, ok: result.ok, message: result.message)
                }
                return
            }
            if type == "guidance_ack", let ack = try? decoder.decode(GuidanceAck.self, from: data) {
                if let key = guidanceRequests[ack.requestId],
                   let expectedSessionID = guidanceRequestSessions[ack.requestId] {
                    guard ResponseValidationPolicy.guidanceMatches(
                        expectedSessionID: expectedSessionID,
                        responseSessionID: ack.sessionId
                    ) else {
                        finishGuidanceFailure(requestID: ack.requestId, reason: "电脑端返回了不匹配的会话确认，消息未确认")
                        return
                    }
                    guidanceStatus[key] = GuidanceUIState(sending: true, ok: nil, message: ack.message)
                    scheduleGuidanceTimeout(
                        requestID: ack.requestId,
                        seconds: 30,
                        reason: "电脑端已收到，但 30 秒未返回 Codex 最终执行结果",
                    )
                }
                return
            }
            if type == "guidance_result", let result = try? decoder.decode(GuidanceResult.self, from: data) {
                if let key = guidanceRequests[result.requestId],
                   let expectedSessionID = guidanceRequestSessions[result.requestId] {
                    guard ResponseValidationPolicy.guidanceMatches(
                        expectedSessionID: expectedSessionID,
                        responseSessionID: result.sessionId
                    ) else {
                        finishGuidanceFailure(requestID: result.requestId, reason: "电脑端返回了不匹配的会话结果，消息未确认")
                        return
                    }
                    guidanceRequests.removeValue(forKey: result.requestId)
                    guidanceRequestSessions.removeValue(forKey: result.requestId)
                    guidanceTimeoutWork.removeValue(forKey: result.requestId)?.cancel()
                    let text = guidanceRequestTexts.removeValue(forKey: result.requestId)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    if result.ok || text.isEmpty {
                        guidanceStatus[key] = GuidanceUIState(sending: false, ok: result.ok, message: result.message)
                    } else {
                        UIPasteboard.general.string = text
                        guidanceStatus[key] = GuidanceUIState(
                            sending: false,
                            ok: false,
                            message: "\(result.message)；本次文字已复制到剪贴板",
                        )
                    }
                }
                return
            }
        }
        guard let snapshot = try? decoder.decode(WireSnapshot.self, from: data),
              snapshot.type == "snapshot", snapshot.machine.id == pairing.id,
              let index = devices.firstIndex(where: { $0.id == pairing.id }) else { return }
        offlineConfirmationWork.removeValue(forKey: pairing.id)?.cancel()
        reconnectWork.removeValue(forKey: pairing.id)?.cancel()
        let previous = Dictionary(uniqueKeysWithValues: devices[index].sessions.map { ($0.id, $0.state) })
        var changed: [(session: SessionStatus, previousState: String?)] = []
        for session in snapshot.sessions {
            if let old = previous[session.id], old != session.state {
                devices[index].newSessionIDs.insert(session.id)
                let key = guidanceKey(pairing.id, session.id)
                let silent = JarvisNotificationPolicy.isSilentCompletion(
                    isJarvis: devices[index].jarvisSessionIDs.contains(session.id),
                    previousState: old,
                    currentState: session.state
                )
                if silent {
                    silentUnreadSessionIDs.insert(key)
                } else {
                    silentUnreadSessionIDs.remove(key)
                }
                changed.append((session, old))
            }
        }
        devices[index].pairing.name = snapshot.machine.name
        devices[index].connected = true
        devices[index].activeConnection = activeEndpoints[pairing.id]?.kind
        devices[index].lastSeen = Date()
        devices[index].sessions = snapshot.sessions
        persistPairings()
        persistUnreadSessionIDs()
        persistSilentUnreadSessionIDs()
        if !changed.isEmpty { lastUnreadReminder = Date() }
        for item in changed {
            postSessionNotification(
                device: devices[index],
                session: item.session,
                previousState: item.previousState
            )
        }
    }

    private func handleTransportFailure(pairing: PairingData, task: URLSessionWebSocketTask) {
        guard tasks[pairing.id] === task else { return }
        tasks.removeValue(forKey: pairing.id)
        sessions.removeValue(forKey: pairing.id)?.invalidateAndCancel()
        advanceEndpoint(for: pairing)
        scheduleReconnect(pairing)
        scheduleOfflineConfirmation(pairing)
    }

    private func scheduleOfflineConfirmation(_ pairing: PairingData) {
        guard monitoringEnabled else { return }
        guard offlineConfirmationWork[pairing.id] == nil else { return }
        offlineConfirmationWork[pairing.id] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(20))
            guard !Task.isCancelled else { return }
            await self?.confirmOffline(pairing: pairing)
        }
    }

    private func scheduleReconnect(_ pairing: PairingData) {
        guard monitoringEnabled else { return }
        guard reconnectWork[pairing.id] == nil else { return }
        reconnectWork[pairing.id] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                self?.reconnectWork.removeValue(forKey: pairing.id)
                self?.connect(pairing)
            }
        }
    }

    private func advanceEndpoint(for pairing: PairingData) {
        let preference = connectionPreference(for: pairing.id)
        let count = pairing.connectionCandidates(for: preference).count
        guard count > 1 else { return }
        endpointIndexes[pairing.id] = ((endpointIndexes[pairing.id] ?? 0) + 1) % count
    }

    private func confirmOffline(pairing: PairingData) async {
        offlineConfirmationWork[pairing.id] = nil
        guard monitoringEnabled else { return }
        if let lastSeen = devices.first(where: { $0.id == pairing.id })?.lastSeen,
           Date().timeIntervalSince(lastSeen) < 20 {
            return
        }
        if await healthReachable(pairing) {
            if tasks[pairing.id] == nil { connect(pairing) }
            scheduleOfflineConfirmation(pairing)
            return
        }
        guard let index = devices.firstIndex(where: { $0.id == pairing.id }), devices[index].connected else { return }
        devices[index].connected = false
        devices[index].activeConnection = nil
        devices[index].newSessionIDs.formUnion(devices[index].sessions.map(\.id))
        if !appActive { postOfflineNotification(device: devices[index]) }
    }

    private func healthReachable(_ pairing: PairingData) async -> Bool {
        for address in pairing.directURLStrings {
            guard var components = URLComponents(string: address) else { continue }
            components.scheme = components.scheme == "wss" ? "https" : "http"
            components.path = "/health"
            components.query = nil
            guard let url = components.url else { continue }
            for attempt in 0..<3 {
                do {
                    let (_, response) = try await URLSession.shared.data(from: url)
                    if (response as? HTTPURLResponse)?.statusCode == 200 { return true }
                } catch { }
                if attempt < 2 { try? await Task.sleep(for: .seconds(1)) }
            }
        }
        return false
    }

    private func checkStaleConnections() {
        guard monitoringEnabled else { return }
        let now = Date()
        for device in devices where device.connected {
            guard let lastSeen = device.lastSeen, now.timeIntervalSince(lastSeen) >= 20,
                  let task = tasks[device.id] else { continue }
            task.cancel(with: .goingAway, reason: nil)
            handleTransportFailure(pairing: device.pairing, task: task)
        }
    }

    private func postSessionNotification(
        device: DeviceViewState,
        session: SessionStatus,
        previousState: String?
    ) {
        guard !JarvisNotificationPolicy.isSilentCompletion(
            isJarvis: device.jarvisSessionIDs.contains(session.id),
            previousState: previousState,
            currentState: session.state
        ) else { return }
        let lamp = SessionLamp(state: session.state, connected: true)
        let content = UNMutableNotificationContent()
        content.title = "\(device.pairing.name) · \(lamp.label)"
        content.subtitle = session.title
        content.body = notificationOverview() + (session.message.isEmpty ? "" : "\n\(session.message)")
        content.sound = .default
        content.userInfo = ["deviceId": device.id, "sessionId": session.id]
        UNUserNotificationCenter.current().add(UNNotificationRequest(
            identifier: "codex-monitor-\(device.id)-\(session.id)-\(UUID().uuidString)",
            content: content,
            trigger: nil
        ))
    }

    private func postOfflineNotification(device: DeviceViewState) {
        let content = UNMutableNotificationContent()
        content.title = "\(device.pairing.name) · 连接未知"
        content.body = notificationOverview()
        content.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(
            identifier: "codex-monitor-\(device.id)-offline-\(UUID().uuidString)",
            content: content,
            trigger: nil
        ))
    }

    private func checkUnreadReminder() {
        guard monitoringEnabled,
              devices.contains(where: { device in
                  device.newSessionIDs.contains { sessionID in
                      !silentUnreadSessionIDs.contains(guidanceKey(device.id, sessionID))
                  }
              }) else {
            lastUnreadReminder = .distantPast
            return
        }
        if lastUnreadReminder == .distantPast {
            lastUnreadReminder = Date()
            return
        }
        guard Date().timeIntervalSince(lastUnreadReminder) >= 60 else { return }
        lastUnreadReminder = Date()
        let content = UNMutableNotificationContent()
        content.title = "仍有未查看的会话状态变化"
        content.body = notificationOverview()
        content.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(
            identifier: "codex-monitor-unread-reminder",
            content: content,
            trigger: nil
        ))
    }

    private func notificationOverview() -> String {
        devices.map { device in
            let lamps = device.sessions.map { SessionLamp(state: $0.state, connected: device.connected).symbol }.joined()
            return "\(device.pairing.name)  \(lamps.isEmpty ? SessionLamp.unknown.symbol : lamps)"
        }.joined(separator: "\n")
    }

    private func beginShortBackgroundWindow() {
        endBackgroundTask()
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "CodexMonitorSocket") { [weak self] in
            Task { @MainActor in self?.endBackgroundTask() }
        }
    }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    private func guidanceKey(_ deviceID: String, _ sessionID: String) -> String {
        "\(deviceID):\(sessionID)"
    }

    private func loadPreferences() {
        if UserDefaults.standard.object(forKey: monitoringEnabledKey) != nil {
            monitoringEnabled = UserDefaults.standard.bool(forKey: monitoringEnabledKey)
        }
        if let data = UserDefaults.standard.data(forKey: pairingsKey),
           let pairings = try? decoder.decode([PairingData].self, from: data) {
            devices = pairings.map(DeviceViewState.init(pairing:))
        }
        if let data = UserDefaults.standard.data(forKey: unreadSessionIDsKey),
           let unread = try? decoder.decode([String: Set<String>].self, from: data) {
            for index in devices.indices {
                devices[index].newSessionIDs = unread[devices[index].id] ?? []
            }
        }
        if let data = UserDefaults.standard.data(forKey: silentUnreadSessionIDsKey),
           let values = try? decoder.decode(Set<String>.self, from: data) {
            silentUnreadSessionIDs = values
        }
        if let data = UserDefaults.standard.data(forKey: jarvisSessionIDsKey),
           let values = try? decoder.decode([String: Set<String>].self, from: data) {
            for index in devices.indices {
                devices[index].jarvisSessionIDs = values[devices[index].id] ?? []
            }
        }
        if let data = UserDefaults.standard.data(forKey: templatesKey),
           let values = try? decoder.decode([String].self, from: data), !values.isEmpty {
            templates = values
        } else {
            templates = defaultTemplates
        }
        if let data = UserDefaults.standard.data(forKey: connectionPreferencesKey),
           let values = try? decoder.decode([String: ConnectionPreference].self, from: data) {
            connectionPreferences = values
        }
    }

    private func persistPairings() {
        if let data = try? encoder.encode(devices.map(\.pairing)) {
            UserDefaults.standard.set(data, forKey: pairingsKey)
        }
    }

    private func persistUnreadSessionIDs() {
        let values = Dictionary(uniqueKeysWithValues: devices.map { ($0.id, $0.newSessionIDs) })
        if let data = try? encoder.encode(values) {
            UserDefaults.standard.set(data, forKey: unreadSessionIDsKey)
        }
    }

    private func persistSilentUnreadSessionIDs() {
        if let data = try? encoder.encode(silentUnreadSessionIDs) {
            UserDefaults.standard.set(data, forKey: silentUnreadSessionIDsKey)
        }
    }

    private func persistJarvisSessionIDs() {
        let values = Dictionary(uniqueKeysWithValues: devices.map { ($0.id, $0.jarvisSessionIDs) })
        if let data = try? encoder.encode(values) {
            UserDefaults.standard.set(data, forKey: jarvisSessionIDsKey)
        }
    }

    @objc private func receivedPushToken(_ notification: Notification) {
        guard notification.object is String else { return }
        registerSystemPush(enabled: monitoringEnabled)
    }

    @objc private func receivedLampPush(_ notification: Notification) {
        consumePendingLampPushes()
    }

    private func consumePendingLampPushes() {
        guard let data = UserDefaults.standard.data(forKey: AppDelegate.pendingEventsKey),
              let events = try? decoder.decode([LampPushEvent].self, from: data) else { return }
        UserDefaults.standard.removeObject(forKey: AppDelegate.pendingEventsKey)
        for event in events where event.isValidTransition && monitoringEnabled {
            guard let index = devices.firstIndex(where: { $0.id == event.deviceId }) else { continue }
            if devices[index].sessions.first(where: { $0.id == event.sessionId })?.state == event.toState { continue }
            devices[index].newSessionIDs.insert(event.sessionId)
            let key = guidanceKey(event.deviceId, event.sessionId)
            if event.silent {
                silentUnreadSessionIDs.insert(key)
            } else {
                silentUnreadSessionIDs.remove(key)
            }
        }
        persistUnreadSessionIDs()
        persistSilentUnreadSessionIDs()
    }

    private func registerSystemPush(enabled: Bool, pairings: [PairingData]? = nil) {
        guard let token = UserDefaults.standard.string(forKey: AppDelegate.pushTokenKey), !token.isEmpty else { return }
        for pairing in pairings ?? devices.map(\.pairing) {
            let message = PushRegistrationMessage(
                pushToken: token,
                enabled: enabled,
                silentCompletionSessionIds: pairings != nil
                    ? (devices.first(where: { $0.id == pairing.id })?.jarvisSessionIDs.sorted() ?? [])
                    : devices.first(where: { $0.id == pairing.id })?.jarvisSessionIDs.sorted() ?? []
            )
            guard let body = try? encoder.encode(message) else { continue }
            guard let url = PushRegistrationEndpoint.url(for: pairing) else { continue }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.timeoutInterval = 15
            Task {
                _ = try? await URLSession.shared.data(for: request)
            }
        }
        if enabled { flushPendingPushReads() }
    }

    private func acknowledgePushRead(pairing: PairingData, sessionID: String, state: String) {
        let pending = PendingPushRead(deviceId: pairing.id, sessionId: sessionID, state: state)
        var values = pendingPushReads()
        values.insert(pending)
        persistPendingPushReads(values)
        sendPendingPushRead(pending, pairing: pairing)
    }

    private func sendPendingPushRead(_ pending: PendingPushRead, pairing: PairingData) {
        guard let token = UserDefaults.standard.string(forKey: AppDelegate.pushTokenKey), !token.isEmpty,
              let url = PushReadEndpoint.url(for: pairing),
              let body = try? encoder.encode(
                PushReadMessage(pushToken: token, sessionId: pending.sessionId, state: pending.state)
              ) else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 15
        Task { [weak self] in
            guard let self else { return }
            guard let (_, response) = try? await URLSession.shared.data(for: request),
                  let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else { return }
            var values = self.pendingPushReads()
            values.remove(pending)
            self.persistPendingPushReads(values)
        }
    }

    private func flushPendingPushReads() {
        let pairings = Dictionary(uniqueKeysWithValues: devices.map { ($0.id, $0.pairing) })
        for pending in pendingPushReads() {
            if let pairing = pairings[pending.deviceId] {
                sendPendingPushRead(pending, pairing: pairing)
            }
        }
    }

    private func pendingPushReads() -> Set<PendingPushRead> {
        guard let data = UserDefaults.standard.data(forKey: pendingPushReadsKey),
              let values = try? decoder.decode(Set<PendingPushRead>.self, from: data) else { return [] }
        return values
    }

    private func persistPendingPushReads(_ values: Set<PendingPushRead>) {
        if values.isEmpty {
            UserDefaults.standard.removeObject(forKey: pendingPushReadsKey)
        } else if let data = try? encoder.encode(values) {
            UserDefaults.standard.set(data, forKey: pendingPushReadsKey)
        }
    }

    private func removePendingPushReads(deviceID: String) {
        persistPendingPushReads(pendingPushReads().filter { $0.deviceId != deviceID }.reduce(into: Set()) { $0.insert($1) })
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.sound]
    }
}

enum EvidenceLoadError: LocalizedError {
    case invalidAddress
    case downloadFailed
    case invalidImage

    var errorDescription: String? {
        switch self {
        case .invalidAddress: "证据图片地址无效"
        case .downloadFailed: "图片下载失败"
        case .invalidImage: "图片类型、大小或内容无效"
        }
    }
}

private extension Sequence where Element: Hashable {
    func uniqued() -> [Element] {
        var seen = Set<Element>()
        return filter { seen.insert($0).inserted }
    }
}
