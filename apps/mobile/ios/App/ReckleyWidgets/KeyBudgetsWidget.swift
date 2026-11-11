import SwiftUI
import WidgetKit

/// "Key Budgets": the budgets the person starred on the Dashboard, on the
/// home screen. Small draws three, medium four.
///
/// ── IT FETCHES FOR ITSELF ───────────────────────────────────────────────────
///
/// The owner's ruling (10 Nov 2026): the widget holds its own read-only key
/// and asks the server, so it stays current while the bank feeds sync and the
/// app is closed. iOS decides when a refresh actually runs; every timeline
/// asks for the next one half an hour on, and the app asks for one whenever a
/// setting changes.
///
/// ── WHAT IT DRAWS WHEN IT CANNOT ────────────────────────────────────────────
///
/// No key: how to turn it on. A key the server refuses: the same, and the key
/// is forgotten so the app's Settings stop saying "on". No network: the last
/// document, with the time it was true. Never a figure from one account under
/// another's key (`BudgetsCache`).
struct KeyBudgetsWidget: Widget {
    static let kind = "KeyBudgets"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: KeyBudgetsProvider()) { entry in
            KeyBudgetsView(entry: entry)
                .containerBackground(Palette.navy, for: .widget)
        }
        .configurationDisplayName("Key Budgets")
        .description("How the budgets you starred on the Dashboard are doing.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct KeyBudgetsEntry: TimelineEntry {
    enum Content: Equatable {
        case needsKey
        case unreachable
        case document(BudgetsDocument, staleSince: Date?)
    }

    let date: Date
    let content: Content
}

struct KeyBudgetsProvider: TimelineProvider {
    /// iOS treats this as a request, not a promise.
    private static let refreshEvery: TimeInterval = 30 * 60

    func placeholder(in context: Context) -> KeyBudgetsEntry {
        KeyBudgetsEntry(date: Date(), content: .document(.sample, staleSince: nil))
    }

    func getSnapshot(in context: Context, completion: @escaping (KeyBudgetsEntry) -> Void) {
        // The gallery shows invented budgets, never the person's own: it is
        // drawn before they have chosen to put anything on a screen.
        if context.isPreview {
            completion(placeholder(in: context))
            return
        }
        Task { completion(await Self.entry()) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<KeyBudgetsEntry>) -> Void) {
        Task {
            let entry = await Self.entry()
            completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(Self.refreshEvery))))
        }
    }

    static func entry(now: Date = Date()) async -> KeyBudgetsEntry {
        switch await BudgetsSource.load(now: now) {
        case .needsKey:
            return KeyBudgetsEntry(date: now, content: .needsKey)
        case .unreachable:
            return KeyBudgetsEntry(date: now, content: .unreachable)
        case .document(let document, let staleSince):
            return KeyBudgetsEntry(date: now, content: .document(document, staleSince: staleSince))
        }
    }
}

/// The budgets document as every widget gets it: one fetch shape, one cache,
/// one answer to a key the server refuses. A refused key is forgotten HERE,
/// whichever widget happened to ask, so the app's Settings stop saying "on".
enum BudgetsSource {
    enum Loaded {
        case needsKey
        case unreachable
        /// `staleSince` is when a kept document was true, when the network gave nothing newer.
        case document(BudgetsDocument, staleSince: Date?)
    }

    static func load(now: Date = Date()) async -> Loaded {
        guard let credential = WidgetKeyStore.read() else {
            BudgetsCache.clear()
            return .needsKey
        }
        switch await BudgetsFetch.run(with: credential) {
        case .document(let document):
            BudgetsCache.save(document, for: credential.keyId)
            return .document(document, staleSince: nil)
        case .refused:
            try? WidgetKeyStore.clear()
            BudgetsCache.clear()
            return .needsKey
        case .unreachable:
            guard let kept = BudgetsCache.read(for: credential.keyId) else { return .unreachable }
            return .document(kept, staleSince: ISO8601DateFormatter.withFraction.date(from: kept.asOf) ?? now)
        }
    }
}

struct KeyBudgetsView: View {
    @Environment(\.widgetFamily) private var family
    let entry: KeyBudgetsEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Spacer(minLength: 6)
            content
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("Budgets")
                .font(.caption2.weight(.semibold))
                .textCase(.uppercase)
                .foregroundStyle(Palette.quiet)
            Spacer(minLength: 4)
            if case .document(_, let staleSince?) = entry.content {
                Text("as of \(staleSince, style: .time)")
                    .font(.caption2)
                    .foregroundStyle(Palette.quiet)
                    .lineLimit(1)
            }
        }
    }

    @ViewBuilder private var content: some View {
        switch entry.content {
        case .needsKey:
            message("Turn on budget widgets in Reckley, under Settings.")
        case .unreachable:
            message("Could not reach Reckley. This will try again.")
        case .document(let document, _):
            let shown = Array(document.forKeyBudgetsWidget.prefix(family == .systemSmall ? 3 : 4))
            if shown.isEmpty {
                message(document.hasBudgets ? "No budget is running today." : "No budgets yet. Add one in Reckley.")
            } else {
                VStack(alignment: .leading, spacing: family == .systemSmall ? 7 : 6) {
                    ForEach(shown) { budget in
                        BudgetRow(budget: budget, stacked: family == .systemSmall)
                            .privacySensitive(document.hideWhenLocked)
                    }
                }
            }
        }
    }

    private func message(_ words: String) -> some View {
        Text(words)
            .font(.footnote)
            .foregroundStyle(Palette.ink)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// One budget: its name, the server's words for how it stands, and a bar.
/// Colour marks only what needs attention — a budget in hand is drawn plain.
struct BudgetRow: View {
    let budget: BudgetsDocument.Budget
    let stacked: Bool

    private var mark: Color { Palette.mark(for: budget.attention) }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if stacked {
                name
                status
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    name
                    Spacer(minLength: 4)
                    status.layoutPriority(1)
                }
            }
            bar
        }
        .accessibilityElement(children: .combine)
    }

    private var name: some View {
        Text(budget.name)
            .font(.caption.weight(.semibold))
            .foregroundStyle(Palette.ink)
            .lineLimit(1)
    }

    private var status: some View {
        Text(budget.status)
            .font(.caption2)
            .foregroundStyle(budget.attention == "none" ? Palette.quiet : mark)
            .lineLimit(1)
    }

    private var bar: some View { BudgetBar(budget: budget) }
}

/// A budget's bar: full at the allowance and no further — there is no more
/// room to draw — while the words beside it keep telling the truth past it.
struct BudgetBar: View {
    let budget: BudgetsDocument.Budget

    var body: some View {
        GeometryReader { space in
            ZStack(alignment: .leading) {
                Capsule().fill(Palette.track)
                Capsule()
                    .fill(Palette.mark(for: budget.attention))
                    .frame(width: space.size.width * min(max(budget.percent, 0), 100) / 100)
                    .widgetAccentable()
            }
        }
        .frame(height: 4)
        .accessibilityHidden(true)
    }
}

/// Fixed colours on the brand's navy, the app header's own ground, in both
/// colour schemes. Each was measured against #1a2332 for WCAG contrast:
/// ink 15.8, quiet 8.3, near 8.9, over 6.3.
enum Palette {
    static let navy = Color(red: 0x1a / 255, green: 0x23 / 255, blue: 0x32 / 255)
    static let ink = Color.white
    static let quiet = Color(red: 0xb4 / 255, green: 0xbd / 255, blue: 0xcb / 255)
    static let track = Color.white.opacity(0.16)
    static let near = Color(red: 0xf5 / 255, green: 0xb9 / 255, blue: 0x42 / 255)
    static let over = Color(red: 0xff / 255, green: 0x7b / 255, blue: 0x72 / 255)

    /// Colour marks only what needs attention: a budget in hand is drawn plain.
    static func mark(for attention: String) -> Color {
        switch attention {
        case "over": return over
        case "near": return near
        default: return ink
        }
    }
}

extension ISO8601DateFormatter {
    /// `Date.toISOString()` writes milliseconds, which the default formatter refuses.
    static let withFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

extension BudgetsDocument {
    /// Invented, for the widget gallery and the placeholder. No person's figures.
    static let sample = BudgetsDocument(
        v: BudgetsFetch.version,
        asOf: "2026-01-01T09:00:00.000Z",
        display: "amounts",
        hideWhenLocked: false,
        hasBudgets: true,
        budgets: [
            sampleBudget("a", "Groceries", 62, "none", "£190 left"),
            sampleBudget("b", "Eating out", 93, "near", "£14 left"),
            sampleBudget("c", "Fuel", 112, "over", "Over by £18"),
            sampleBudget("d", "Household", 35, "none", "£130 left"),
        ]
    )

    private static func sampleBudget(_ id: String, _ name: String, _ percent: Double, _ attention: String, _ status: String) -> Budget {
        Budget(id: id, name: name, key: true, percent: percent, attention: attention, status: status,
               period: "Monthly", until: "2026-01-31", daysLeft: 12, spent: nil, allowance: nil, perDay: nil)
    }
}
