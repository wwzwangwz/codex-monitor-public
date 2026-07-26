import AVFoundation
import SwiftUI

struct ScannerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onCode: (String) -> Void
    @State private var cameraUnavailable = false

    var body: some View {
        NavigationStack {
            ZStack {
                QRScannerView(
                    onCode: onCode,
                    onCameraUnavailable: { cameraUnavailable = true }
                )
                    .ignoresSafeArea()
                if cameraUnavailable {
                    cameraUnavailableView
                } else {
                    RoundedRectangle(cornerRadius: 12)
                        .stroke(.white, lineWidth: 3)
                        .frame(width: 245, height: 245)
                        .shadow(color: .black.opacity(0.35), radius: 5)
                }
            }
            .navigationTitle("扫描电脑二维码")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("取消") { dismiss() } }
        }
    }

    private var cameraUnavailableView: some View {
        VStack(spacing: 14) {
            Image(systemName: "camera.fill")
                .font(.system(size: 36))
            Text("无法使用相机")
                .font(.headline)
            Text("请在系统设置中允许 Codex Monitor 使用相机。")
                .font(.subheadline)
                .multilineTextAlignment(.center)
            Button("打开设置") {
                guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                UIApplication.shared.open(url)
            }
            .buttonStyle(.borderedProminent)
        }
        .foregroundStyle(.white)
        .padding(24)
        .background(.black.opacity(0.82), in: RoundedRectangle(cornerRadius: 8))
        .padding(28)
    }
}

struct QRScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onCameraUnavailable: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onCode: onCode, onCameraUnavailable: onCameraUnavailable)
    }

    func makeUIViewController(context: Context) -> ScannerViewController {
        let controller = ScannerViewController()
        controller.onCode = context.coordinator.handle
        controller.onCameraUnavailable = context.coordinator.cameraUnavailable
        return controller
    }

    func updateUIViewController(_ uiViewController: ScannerViewController, context: Context) { }

    final class Coordinator {
        let onCode: (String) -> Void
        let onCameraUnavailable: () -> Void

        init(onCode: @escaping (String) -> Void, onCameraUnavailable: @escaping () -> Void) {
            self.onCode = onCode
            self.onCameraUnavailable = onCameraUnavailable
        }

        func handle(_ value: String) { onCode(value) }
        func cameraUnavailable() { onCameraUnavailable() }
    }
}

final class ScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    var onCameraUnavailable: (() -> Void)?
    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?
    private var delivered = false
    private var configured = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        prepareCamera()
    }

    private func prepareCamera() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configureSession()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    if granted { self?.configureSession() } else { self?.onCameraUnavailable?() }
                }
            }
        case .denied, .restricted:
            onCameraUnavailable?()
        @unknown default:
            onCameraUnavailable?()
        }
    }

    private func configureSession() {
        guard !configured else { return }
        guard let camera = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: camera),
              session.canAddInput(input) else {
            onCameraUnavailable?()
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            onCameraUnavailable?()
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        preview = layer
        configured = true
        layer.frame = view.bounds
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in self?.session.startRunning() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        DispatchQueue.global(qos: .utility).async { [weak self] in self?.session.stopRunning() }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !delivered,
              let code = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let value = code.stringValue else { return }
        delivered = true
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        onCode?(value)
    }
}
