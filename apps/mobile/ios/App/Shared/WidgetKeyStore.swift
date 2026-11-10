import Foundation
import Security

/// Where the widget's read-only key lives on this phone.
///
/// ── ONE ITEM, WRITTEN WHOLE ─────────────────────────────────────────────────
///
/// The key, the server's id for it and the origin to fetch from are one
/// keychain item, replaced together. The origin says where the key is SENT,
/// so the two may never be changed apart: a page that could move the origin
/// while the key stayed would be handed the key by the next refresh. There is
/// no call here that does that, and no call that reads the key back to a page.
///
/// ── THE KEYCHAIN, NOT A SHARED PREFERENCES FILE ─────────────────────────────
///
/// The app writes and the widget extension reads, so the item is in an access
/// group both are entitled to (`keychain-access-groups` in each target's
/// entitlements). A keychain item marked this-device-only stays out of
/// backups, which a preferences file in a shared container does not. It is
/// readable after the first unlock since the phone started, because a widget
/// refreshes while the phone is locked in a pocket.
///
/// A keychain item outlives the app that wrote it. `forgetIfFreshInstall()`
/// is what stops a re-installed app inheriting a key from the copy that was
/// deleted.
///
/// This file is compiled into BOTH targets.
struct WidgetCredential: Codable, Equatable {
    let key: String
    let keyId: String
    let origin: String
}

enum WidgetKeyStore {
    /// `$(AppIdentifierPrefix)` is the team id and a dot; the entitlement
    /// expands it, and code has to spell it. Changing either strands the key
    /// every installed copy holds.
    static let accessGroup = "VT6W829WRX.com.wealthtracker.mobile.widget"
    private static let service = "com.wealthtracker.mobile.widget-key"
    private static let account = "credential"
    private static let installedMarker = "reckleyWidgetKeyStoreInstalled"

    private static var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
        ]
    }

    /// The credential, or nil when this phone holds none (or cannot say).
    static func read() -> WidgetCredential? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess,
              let data = found as? Data else { return nil }
        return try? JSONDecoder().decode(WidgetCredential.self, from: data)
    }

    /// Replace whatever is held. Throws with the keychain's own status when it refuses.
    static func write(_ credential: WidgetCredential) throws {
        let data = try JSONEncoder().encode(credential)
        let deleted = SecItemDelete(baseQuery as CFDictionary)
        guard deleted == errSecSuccess || deleted == errSecItemNotFound else {
            throw WidgetKeyStoreError.keychain(deleted)
        }
        var attributes = baseQuery
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(attributes as CFDictionary, nil)
        guard added == errSecSuccess else { throw WidgetKeyStoreError.keychain(added) }
    }

    /// Forget the key. Holding none already is success.
    static func clear() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw WidgetKeyStoreError.keychain(status)
        }
    }

    /// Called by the APP as it starts. Preferences die with the app and the
    /// keychain does not, so a missing marker beside a held key means the key
    /// belongs to a copy that was deleted.
    static func forgetIfFreshInstall(defaults: UserDefaults = .standard) {
        guard !defaults.bool(forKey: installedMarker) else { return }
        try? clear()
        defaults.set(true, forKey: installedMarker)
    }
}

enum WidgetKeyStoreError: Error, CustomStringConvertible {
    case keychain(OSStatus)

    var description: String {
        switch self {
        case .keychain(let status):
            let words = SecCopyErrorMessageString(status, nil) as String? ?? "no description"
            return "Keychain refused (\(status)): \(words)"
        }
    }
}
