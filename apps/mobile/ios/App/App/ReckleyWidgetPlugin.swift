import Capacitor
import Foundation
import WidgetKit

/// The shell's side of the hand-over to the home-screen widgets.
///
/// The page's side is `src/services/widget/widgetBridge.ts`, and the four
/// methods here are the contract it was written to:
///
///     status()                         → { hasKey, keyId }
///     setKey({ key, keyId, origin })   store it where the widget reads it, redraw
///     clearKey()                       forget it, redraw
///     reload()                         redraw — the settings changed
///
/// ── THE KEY GOES IN AND NEVER COMES BACK OUT ────────────────────────────────
///
/// The shell loads its page from the network, so whatever is in the web view
/// can call these. `status()` answers with the server's id for the key, which
/// is what a revoke names and is no use to anyone else; nothing answers with
/// the key. A page can only ever replace the key AND the origin together
/// (`WidgetKeyStore`), so the worst a wrong page can do is point the widget at
/// itself with a key it already had.
///
/// ── REGISTERED BY HAND ──────────────────────────────────────────────────────
///
/// Capacitor finds packaged plugins through `capacitor.config.json`'s class
/// list. This one lives in the app target, so `ReckleyBridgeViewController`
/// registers the instance itself, before the web view loads — which is also
/// what makes `Capacitor.isPluginAvailable('ReckleyWidget')` true on the page.
/// The name is the JS name: changing it hides the Settings card on every
/// installed copy.
@objc(ReckleyWidgetPlugin)
public class ReckleyWidgetPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ReckleyWidgetPlugin"
    public let jsName = "ReckleyWidget"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reload", returnType: CAPPluginReturnPromise),
    ]

    /// What the server mints (`api/_lib/widget-key`): the prefix, then the secret.
    private static let keyPrefix = "rkw_"
    private static let longestKey = 256

    override public func load() {
        WidgetKeyStore.forgetIfFreshInstall()
    }

    @objc func status(_ call: CAPPluginCall) {
        let credential = WidgetKeyStore.read()
        call.resolve([
            "hasKey": credential != nil,
            "keyId": credential?.keyId as Any? ?? NSNull(),
        ])
    }

    @objc func setKey(_ call: CAPPluginCall) {
        guard let key = call.getString("key"),
              key.hasPrefix(Self.keyPrefix), key.count > Self.keyPrefix.count, key.count <= Self.longestKey else {
            call.reject("That is not a widget key")
            return
        }
        guard let keyId = call.getString("keyId"), !keyId.isEmpty, keyId.count <= 64 else {
            call.reject("The key has no id")
            return
        }
        guard let origin = Self.usableOrigin(call.getString("origin")) else {
            call.reject("The widget can only fetch from an https origin")
            return
        }
        do {
            try WidgetKeyStore.write(WidgetCredential(key: key, keyId: keyId, origin: origin))
        } catch {
            call.reject("This phone would not store the key", nil, error)
            return
        }
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }

    @objc func clearKey(_ call: CAPPluginCall) {
        do {
            try WidgetKeyStore.clear()
        } catch {
            call.reject("This phone would not forget the key", nil, error)
            return
        }
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }

    @objc func reload(_ call: CAPPluginCall) {
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }

    /// `https://host[:port]`, rebuilt from its parts so that nothing a page
    /// appended (a path, a query, credentials) is carried into the request.
    static func usableOrigin(_ raw: String?) -> String? {
        guard let raw, let parts = URLComponents(string: raw),
              parts.scheme == "https", let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil else { return nil }
        var origin = "https://\(host.lowercased())"
        if let port = parts.port { origin += ":\(port)" }
        return origin
    }
}
