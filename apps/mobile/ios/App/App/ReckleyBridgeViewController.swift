import Capacitor

/// Capacitor's bridge view controller, plus the one plugin that lives in the
/// app target rather than in a package.
///
/// `capacitorDidLoad()` runs after the bridge exists and BEFORE the web view
/// loads its first page, and registering there adds the plugin's script at
/// document start — so the page finds `ReckleyWidget` from its first line,
/// on the remote site as on a bundled one. `Main.storyboard` names this class.
class ReckleyBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ReckleyWidgetPlugin())
    }
}
