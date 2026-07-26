// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CodexMonitorCore",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "CodexMonitorCore", targets: ["CodexMonitorCore"]),
    ],
    targets: [
        .target(
            name: "CodexMonitorCore",
            path: "CodexMonitorIOS/Core"
        ),
        .testTarget(
            name: "CodexMonitorCoreTests",
            dependencies: ["CodexMonitorCore"],
            path: "Tests"
        ),
    ]
)
