import UIKit

extension Notification.Name {
    static let codexPushToken = Notification.Name("CodexMonitorPushToken")
    static let codexLampPush = Notification.Name("CodexMonitorLampPush")
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    static let pushTokenKey = "apns_device_token_v1"
    static let pendingEventsKey = "pending_lamp_push_events_v1"

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        application.registerForRemoteNotifications()
        if let remote = launchOptions?[.remoteNotification] as? [AnyHashable: Any] {
            postLampEvent(remote)
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(token, forKey: Self.pushTokenKey)
        NotificationCenter.default.post(name: .codexPushToken, object: token)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // The app remains fully usable over LAN when Push Notifications are unavailable.
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        postLampEvent(userInfo)
        completionHandler(.newData)
    }

    private func postLampEvent(_ userInfo: [AnyHashable: Any]) {
        guard let value = userInfo["codex"] as? [String: Any],
              JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value),
              let event = try? JSONDecoder().decode(LampPushEvent.self, from: data),
              event.isValidTransition else { return }
        let previous = UserDefaults.standard.data(forKey: Self.pendingEventsKey)
            .flatMap { try? JSONDecoder().decode([LampPushEvent].self, from: $0) } ?? []
        if let encoded = try? JSONEncoder().encode(Array((previous + [event]).suffix(50))) {
            UserDefaults.standard.set(encoded, forKey: Self.pendingEventsKey)
        }
        NotificationCenter.default.post(name: .codexLampPush, object: event)
    }
}
