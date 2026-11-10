import SwiftUI
import WidgetKit

/// Every home-screen widget Reckley offers. One today; the others the owner
/// asked for (one chosen budget, left to spend, the lock-screen ring) join
/// this list.
@main
struct ReckleyWidgetsBundle: WidgetBundle {
    var body: some Widget {
        KeyBudgetsWidget()
    }
}
