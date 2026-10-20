import Foundation

/// Values shared between the app and its broadcast extension through the app group.
enum SharedSettings {
    static let appGroup = "group.com.classroombridge.shared"
    static let extensionBundleID = "com.classroombridge.app.broadcast"
    static let defaultSignalURL = "wss://classroom-bridge.nathan-sant.workers.dev"
    static let pairingAlphabet = Set("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")

    private static let codeKey = "pairingCode"
    private static let urlKey = "signalURL"
    private static var defaults: UserDefaults { UserDefaults(suiteName: appGroup) ?? .standard }

    static func normalise(_ raw: String) -> String {
        String(raw.uppercased().filter { pairingAlphabet.contains($0) }.prefix(12))
    }

    static var pairingCode: String {
        get { defaults.string(forKey: codeKey) ?? "" }
        set { defaults.set(normalise(newValue), forKey: codeKey) }
    }

    static var isValidCode: Bool { pairingCode.count == 12 }

    static var signalURL: String {
        get { defaults.string(forKey: urlKey) ?? defaultSignalURL }
        set { defaults.set(newValue, forKey: urlKey) }
    }

    static func socketURL() -> URL? {
        let base = signalURL.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
        return URL(string: "\(base)/signal/\(pairingCode)?role=screen")
    }
}
