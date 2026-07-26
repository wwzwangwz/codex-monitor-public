import SwiftUI

private let canvas = Color(red: 0.965, green: 0.973, blue: 0.969)
private let ink = Color(red: 0.095, green: 0.125, blue: 0.113)
private let muted = Color(red: 0.40, green: 0.45, blue: 0.43)

struct SessionRoute: Hashable {
    let deviceID: String
    let sessionID: String
}

struct ContentView: View {
    @EnvironmentObject private var monitor: MonitorController
    @State private var showingScanner = false
    @State private var showingAbout = false

    var body: some View {
        NavigationStack {
            Group {
                if monitor.devices.isEmpty {
                    emptyState
                } else {
                    deviceList
                }
            }
            .background(canvas)
            .navigationTitle("Codex Monitor")
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button { showingAbout = true } label: {
                        Image(systemName: "info.circle")
                    }
                    .accessibilityLabel("关于与连接说明")
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { showingScanner = true } label: {
                        Image(systemName: "qrcode.viewfinder")
                    }
                    .accessibilityLabel("扫码连接电脑")
                }
            }
            .navigationDestination(for: SessionRoute.self) { route in
                SessionDetailView(deviceID: route.deviceID, sessionID: route.sessionID)
            }
        }
        .tint(ink)
        .sheet(isPresented: $showingScanner) {
            ScannerSheet { value in
                monitor.addPairing(qrValue: value)
                if monitor.pairingError == nil { showingScanner = false }
            }
        }
        .sheet(isPresented: $showingAbout) {
            AboutView()
        }
        .alert("无法连接", isPresented: Binding(
            get: { monitor.pairingError != nil },
            set: { if !$0 { monitor.pairingError = nil } }
        )) {
            Button("知道了", role: .cancel) { monitor.pairingError = nil }
        } message: {
            Text(monitor.pairingError ?? "未知错误")
        }
    }

    private var deviceList: some View {
        List {
            Section {
                monitoringToggle
                HStack {
                    Label("\(monitor.devices.filter(\.connected).count) 台在线", systemImage: "desktopcomputer")
                    Spacer()
                    Text("\(monitor.devices.reduce(0) { $0 + $1.sessions.count }) 个会话")
                }
                .font(.footnote)
                .foregroundStyle(muted)
            }
            ForEach(monitor.devices) { device in
                Section {
                    if device.sessions.isEmpty {
                        Text(device.connected ? "电脑端尚未选择会话" : "等待电脑数据")
                            .font(.subheadline)
                            .foregroundStyle(muted)
                    } else {
                        ForEach(device.sessions.sorted { a, b in
                        let aJarvis = monitor.isJarvisSession(deviceID: device.id, sessionID: a.id)
                        let bJarvis = monitor.isJarvisSession(deviceID: device.id, sessionID: b.id)
                        if aJarvis != bJarvis { return aJarvis }
                        return false
                    }) { session in
                            NavigationLink(value: SessionRoute(deviceID: device.id, sessionID: session.id)) {
                                SessionRow(
                                    session: session,
                                    connected: device.connected,
                                    isNew: device.newSessionIDs.contains(session.id),
                                    isJarvis: monitor.isJarvisSession(deviceID: device.id, sessionID: session.id)
                                )
                            }
                            .simultaneousGesture(TapGesture().onEnded {
                                monitor.clearNew(deviceID: device.id, sessionID: session.id)
                            })
                        }
                    }
                } header: {
                    DeviceHeader(
                        device: device,
                        monitoringEnabled: monitor.monitoringEnabled,
                        preference: monitor.connectionPreference(for: device.id),
                        onPreference: { monitor.setConnectionPreference($0, deviceID: device.id) },
                        onDisconnect: { monitor.disconnect(device.id) }
                    )
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .refreshable { monitor.setAppActive(true) }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            monitoringToggle
                .padding(14)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 8))
                .padding(.horizontal, 20)
            Image(systemName: "display.2")
                .font(.system(size: 42, weight: .medium))
                .foregroundStyle(muted)
            Text("尚未连接设备")
                .font(.headline)
            Button {
                showingScanner = true
            } label: {
                Label("扫码连接", systemImage: "qrcode.viewfinder")
                    .frame(minWidth: 120)
            }
            .buttonStyle(.borderedProminent)
            .tint(ink)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var monitoringToggle: some View {
        Toggle(isOn: Binding(
            get: { monitor.monitoringEnabled },
            set: { monitor.setMonitoringEnabled($0) }
        )) {
            VStack(alignment: .leading, spacing: 3) {
                Label(
                    "会话监控",
                    systemImage: monitor.monitoringEnabled ? "dot.radiowaves.left.and.right" : "pause.circle"
                )
                .font(.subheadline.weight(.semibold))
                Text(monitor.monitoringEnabled ? "正在连接并接收状态变化" : "已暂停，不连接设备")
                    .font(.caption)
                    .foregroundStyle(muted)
            }
        }
        .tint(Color(red: 0.14, green: 0.63, blue: 0.40))
    }
}

private struct DeviceHeader: View {
    let device: DeviceViewState
    let monitoringEnabled: Bool
    let preference: ConnectionPreference
    let onPreference: (ConnectionPreference) -> Void
    let onDisconnect: () -> Void

    var body: some View {
        HStack(spacing: 9) {
            Circle()
                .fill(device.connected ? lampColor(.running) : lampColor(.unknown))
                .frame(width: 9, height: 9)
            VStack(alignment: .leading, spacing: 2) {
                Text(device.pairing.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(ink)
                    .lineLimit(1)
                Text(device.connected ? connectedLabel : (monitoringEnabled ? "状态未知，正在重连" : "监控已关闭"))
                    .font(.caption)
                    .foregroundStyle(muted)
            }
            Spacer()
            Menu {
                Picker("连接方式", selection: Binding(
                    get: { preference },
                    set: onPreference
                )) {
                    Text("自动").tag(ConnectionPreference.automatic)
                    Text("局域网直连").tag(ConnectionPreference.direct)
                        .disabled(device.pairing.directURLString == nil)
                    Text("远程中继").tag(ConnectionPreference.relay)
                        .disabled(device.pairing.remoteURLString == nil)
                }
                Divider()
                Button(role: .destructive, action: onDisconnect) {
                    Label("断开设备", systemImage: "link.badge.minus")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.body)
            }
        }
        .textCase(nil)
        .padding(.vertical, 3)
    }

    private var connectedLabel: String {
        switch device.activeConnection {
        case .direct: return "已连接 · 局域网"
        case .relay: return "已连接 · 远程"
        case .automatic, .none: return "已连接"
        }
    }
}

private struct SessionRow: View {
    let session: SessionStatus
    let connected: Bool
    let isNew: Bool
    let isJarvis: Bool
    @State private var newPulse = false

    private var lamp: SessionLamp { SessionLamp(state: session.state, connected: connected) }

    var body: some View {
        HStack(alignment: .top, spacing: 11) {
            Circle()
                .fill(lampColor(lamp))
                .frame(width: 11, height: 11)
                .padding(.top, 5)
            VStack(alignment: .leading, spacing: 4) {
                Text(session.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                if isJarvis {
                    Label("健康管家", systemImage: "cross.case.fill")
                        .font(.caption2)
                        .foregroundStyle(Color(red: 0.14, green: 0.63, blue: 0.40))
                }
                Text(session.message)
                    .font(.caption)
                    .foregroundStyle(muted)
                    .lineLimit(2)
                if isJarvis {
                    Label("健康管家", systemImage: "cross.case.fill")
                        .font(.caption2)
                        .foregroundStyle(Color(red: 0.14, green: 0.63, blue: 0.40))
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 6) {
                Text(lamp.label)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(lampColor(lamp))
                if isNew {
                    Text("NEW")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(Color.blue)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(Color.blue.opacity(0.1), in: RoundedRectangle(cornerRadius: 4))
                        .opacity(newPulse ? 0.22 : 1)
                        .animation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true), value: newPulse)
                        .onAppear { newPulse = true }
                }
            }
        }
        .padding(.vertical, 4)
    }
}

func lampColor(_ lamp: SessionLamp) -> Color {
    switch lamp {
    case .running: return Color(red: 0.14, green: 0.63, blue: 0.40)
    case .blocked: return Color(red: 0.85, green: 0.29, blue: 0.29)
    case .completed: return Color(red: 0.19, green: 0.52, blue: 0.85)
    case .unknown: return Color(red: 0.14, green: 0.15, blue: 0.15)
    }
}

private struct AboutView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("版本") {
                    LabeledContent("iPhone 客户端", value: MonitorController.appVersion)
                    LabeledContent("状态协议", value: "v\(MonitorController.statusProtocolVersion)")
                }
                Section("连接") {
                    Label("局域网二维码使用 ws:// 直连", systemImage: "wifi")
                    Label("未来公网中继使用 wss://，无需更改界面", systemImage: "network")
                }
                Section("后台说明") {
                    Text("iOS 会在系统允许的短时后台窗口继续监听。真正长期后台通知需要公网中继通过 APNs 推送；强制退出 App 后局域网直连无法继续通知。")
                        .font(.subheadline)
                        .foregroundStyle(muted)
                }
                Section("更新日志") {
                    ForEach(MonitorController.releaseNotes, id: \.self) { Text($0) }
                }
            }
            .navigationTitle("关于")
            .toolbar { Button("完成") { dismiss() } }
        }
    }
}
