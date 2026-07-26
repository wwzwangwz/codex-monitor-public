import SwiftUI
import UIKit
import PhotosUI

struct SessionDetailView: View {
    @EnvironmentObject private var monitor: MonitorController
    let deviceID: String
    let sessionID: String
    @State private var input = ""
    @State private var lastSentInput: String?
    @State private var mode: GuidanceMode = .steer
    @State private var editingTemplates = false
    @State private var confirmingGoalDelete = false
    @State private var selectedEvidence: LoadedEvidence?
    @State private var selectedPhotoItems: [PhotosPickerItem] = []
    @State private var guidanceImages: [PreparedGuidanceImage] = []
    @State private var preparingImages = false
    @State private var imageError: String?

    private var device: DeviceViewState? { monitor.device(deviceID) }
    private var session: SessionStatus? { monitor.session(deviceID: deviceID, sessionID: sessionID) }
    private var status: GuidanceUIState? { monitor.guidanceStatus["\(deviceID):\(sessionID)"] }
    private var goalStatus: GoalCommandUIState? { monitor.goalCommandStatus["\(deviceID):\(sessionID)"] }

    var body: some View {
        Form {
            Section {
                HStack(spacing: 10) {
                    Circle()
                        .fill(lampColor(lamp))
                        .frame(width: 12, height: 12)
                    Text(lamp.label)
                        .font(.subheadline.weight(.semibold))
                    Spacer()
                    Text(device?.pairing.name ?? "设备")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let message = session?.message, !message.isEmpty {
                    Text(message)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                ForEach(monitor.templates, id: \.self) { template in
                    Button(template) { input = template }
                        .foregroundStyle(.primary)
                }
                Button {
                    editingTemplates = true
                } label: {
                    Label("编辑模板", systemImage: "square.and.pencil")
                }
            } header: {
                Text("快捷引导")
            }

            Section("给 Codex 的消息") {
                TextEditor(text: $input)
                    .frame(minHeight: 110)
                    .onChange(of: input) { value in
                        if value.count > 2000 { input = String(value.prefix(2000)) }
                    }
                HStack(spacing: 18) {
                    Spacer()
                    Button {
                        input = lastSentInput ?? monitor.lastGuidance(deviceID: deviceID, sessionID: sessionID) ?? ""
                    } label: {
                        Image(systemName: "arrow.uturn.backward")
                    }
                    .accessibilityLabel("恢复上一条发送内容")
                    .disabled(!input.isEmpty || (lastSentInput ?? monitor.lastGuidance(deviceID: deviceID, sessionID: sessionID)) == nil)
                    Button { input = "" } label: {
                        Image(systemName: "trash")
                    }
                    .accessibilityLabel("清空输入")
                    .disabled(input.isEmpty)
                }
                Picker("发送方式", selection: $mode) {
                    Text("引导当前").tag(GuidanceMode.steer)
                    Text("排队下一轮").tag(GuidanceMode.queue)
                }
                .pickerStyle(.segmented)
                PhotosPicker(
                    selection: $selectedPhotoItems,
                    maxSelectionCount: GuidanceImagePreparer.maxImages,
                    matching: .images,
                ) {
                    Label(
                        preparingImages ? "正在处理图片" : "添加截图（最多 10 张）",
                        systemImage: "photo.on.rectangle",
                    )
                }
                .disabled(preparingImages || status?.sending == true)
                .onChange(of: selectedPhotoItems) { items in
                    guard !items.isEmpty else { return }
                    preparingImages = true
                    imageError = nil
                    Task { @MainActor in
                        do {
                            guidanceImages = try await GuidanceImagePreparer.prepare(items)
                        } catch {
                            guidanceImages = []
                            imageError = error.localizedDescription
                        }
                        preparingImages = false
                    }
                }
                if !guidanceImages.isEmpty {
                    ForEach(guidanceImages) { item in
                        HStack(spacing: 10) {
                            Image(uiImage: item.preview)
                                .resizable()
                                .scaledToFill()
                                .frame(width: 52, height: 52)
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                            VStack(alignment: .leading, spacing: 3) {
                                Text(item.attachment.name).font(.subheadline)
                                Text("\(item.attachment.sizeBytes / 1024) KiB")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button(role: .destructive) {
                                guidanceImages.removeAll { $0.id == item.id }
                                selectedPhotoItems = []
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                            }
                            .accessibilityLabel("移除 \(item.attachment.name)")
                        }
                    }
                }
                if let imageError {
                    Label(imageError, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
                Button {
                    let submitted = input.trimmingCharacters(in: .whitespacesAndNewlines)
                    if monitor.sendGuidance(
                        deviceID: deviceID,
                        sessionID: sessionID,
                        text: submitted,
                        mode: mode,
                        attachments: guidanceImages.map(\.attachment)
                    ) {
                        lastSentInput = submitted
                        input = ""
                        guidanceImages = []
                        selectedPhotoItems = []
                        imageError = nil
                    }
                } label: {
                    HStack {
                        Spacer()
                        if status?.sending == true { ProgressView().padding(.trailing, 6) }
                        Text(status?.sending == true ? "发送中" : "发送")
                        Spacer()
                    }
                }
                .disabled(
                    (input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && guidanceImages.isEmpty)
                    || status?.sending == true
                    || preparingImages
                )
            }

            if let status {
                Section("发送结果") {
                    Label(status.message, systemImage: resultIcon(status.ok))
                        .foregroundStyle(resultColor(status.ok))
                }
            }

            if let evidence = session?.evidence, !evidence.isEmpty {
                Section("重要证据") {
                    ScrollView(.horizontal) {
                        HStack(spacing: 10) {
                            ForEach(evidence.prefix(10)) { item in
                                EvidenceThumbnail(deviceID: deviceID, evidence: item) { image in
                                    selectedEvidence = LoadedEvidence(evidence: item, image: image)
                                }
                            }
                        }
                        .padding(.vertical, 4)
                    }
                    .scrollIndicators(.hidden)
                }
            }

            if let goal = session?.goal {
            /* --------- 贾维斯健康管家 --------- */
            Section {
                Toggle(isOn: Binding(
                    get: { monitor.isJarvisSession(deviceID: deviceID, sessionID: sessionID) },
                    set: { monitor.setJarvisSession(deviceID: deviceID, sessionID: sessionID, enabled: $0) }
                )) {
                    VStack(alignment: .leading, spacing: 3) {
                        Label("健康管家", systemImage: "cross.case.fill")
                            .font(.subheadline.weight(.semibold))
                        Text("巡检完成（绿→蓝）静默不提醒；受阻/异常仍正常通知")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .tint(Color(red: 0.14, green: 0.63, blue: 0.40))
            }

                Section("Goal 控制") {
                    if !goal.objective.isEmpty {
                        Text(goal.objective)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    LabeledContent("当前状态", value: goal.status)
                    Button {
                        monitor.sendGoalCommand(deviceID: deviceID, sessionID: sessionID, command: "resume", confirmed: false)
                    } label: {
                        Label("重启受阻 Goal", systemImage: "arrow.clockwise")
                    }
                    .disabled(!canResumeGoal || goalStatus?.sending == true)
                    Button(role: .destructive) {
                        confirmingGoalDelete = true
                    } label: {
                        Label("删除 Goal", systemImage: "trash")
                    }
                    .disabled(goalStatus?.sending == true)
                    if let goalStatus {
                        Label(goalStatus.message, systemImage: resultIcon(goalStatus.ok))
                            .font(.footnote)
                            .foregroundStyle(resultColor(goalStatus.ok))
                    }
                }
            }
        }
        .navigationTitle(session?.title ?? "会话")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $editingTemplates) {
            TemplateEditor(values: monitor.templates) { monitor.saveTemplates($0) }
        }
        .alert("删除这个 Goal？", isPresented: $confirmingGoalDelete) {
            Button("删除 Goal", role: .destructive) {
                monitor.sendGoalCommand(deviceID: deviceID, sessionID: sessionID, command: "delete", confirmed: true)
            }
            Button("取消", role: .cancel) { }
        } message: {
            Text("只删除 Goal 目标关联，不会删除 Codex 会话、聊天记录或工作文件。")
        }
        .sheet(item: $selectedEvidence) { selected in
            EvidenceViewer(evidence: selected)
        }
    }

    private var lamp: SessionLamp {
        SessionLamp(state: session?.state ?? "unknown", connected: device?.connected == true)
    }

    private var canResumeGoal: Bool {
        guard session?.state != "running", let status = session?.goal?.status else { return false }
        return ["blocked", "usage_limited", "budget_limited"].contains(status)
    }

    private func resultIcon(_ ok: Bool?) -> String {
        if ok == true { return "checkmark.circle.fill" }
        if ok == false { return "exclamationmark.circle.fill" }
        return "clock"
    }

    private func resultColor(_ ok: Bool?) -> Color {
        if ok == true { return .green }
        if ok == false { return .red }
        return .secondary
    }
}

private struct LoadedEvidence: Identifiable {
    let evidence: EvidenceImage
    let image: UIImage
    var id: String { evidence.id }
}

private struct EvidenceThumbnail: View {
    @EnvironmentObject private var monitor: MonitorController
    let deviceID: String
    let evidence: EvidenceImage
    let onOpen: (UIImage) -> Void
    @State private var image: UIImage?
    @State private var error: String?

    var body: some View {
        Button {
            if let image { onOpen(image) }
        } label: {
            ZStack {
                RoundedRectangle(cornerRadius: 7)
                    .fill(Color(uiColor: .secondarySystemBackground))
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 76, height: 76)
                        .clipShape(RoundedRectangle(cornerRadius: 7))
                } else if error != nil {
                    Label("不可用", systemImage: "exclamationmark.triangle")
                        .font(.caption2)
                        .foregroundStyle(.red)
                } else {
                    ProgressView()
                }
            }
            .frame(width: 76, height: 76)
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(.quaternary))
        }
        .buttonStyle(.plain)
        .disabled(image == nil)
        .accessibilityLabel(evidence.name)
        .task(id: evidence.id) {
            do {
                image = try await monitor.loadEvidence(deviceID: deviceID, evidence: evidence)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

private struct EvidenceViewer: View {
    @Environment(\.dismiss) private var dismiss
    let evidence: LoadedEvidence

    var body: some View {
        NavigationStack {
            GeometryReader { proxy in
                Image(uiImage: evidence.image)
                    .resizable()
                    .scaledToFit()
                    .frame(width: proxy.size.width, height: proxy.size.height)
                    .background(.black)
            }
            .navigationTitle(evidence.evidence.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("关闭") { dismiss() }
                }
            }
        }
    }
}

private struct TemplateEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State var values: [String]
    let onSave: ([String]) -> Void

    var body: some View {
        NavigationStack {
            List {
                ForEach(values.indices, id: \.self) { index in
                    TextField("模板 \(index + 1)", text: $values[index], axis: .vertical)
                }
                .onDelete { values.remove(atOffsets: $0) }
                Button {
                    values.append("")
                } label: {
                    Label("添加模板", systemImage: "plus")
                }
                    .disabled(values.count >= 8)
            }
            .navigationTitle("编辑模板")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        onSave(values)
                        dismiss()
                    }
                }
            }
        }
    }
}
