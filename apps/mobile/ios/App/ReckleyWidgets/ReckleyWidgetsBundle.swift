import SwiftUI
import WidgetKit

/// Every widget Reckley offers: the Key Budgets on the home screen, and one
/// chosen budget on the home screen and the lock screen.
@main
struct ReckleyWidgetsBundle: WidgetBundle {
    var body: some Widget {
        KeyBudgetsWidget()
        OneBudgetWidget()
    }
}
