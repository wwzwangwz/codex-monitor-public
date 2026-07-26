import SwiftUI

@main
struct CodexMonitorApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var monitor = MonitorController()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(monitor)
                .task { monitor.start() }
                .onChange(of: scenePhase) { phase in
                    monitor.setAppActive(phase == .active)
                }
        }
    }
}
