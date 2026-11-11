import AppIntents
import SwiftUI
import WidgetKit

/// "Budget": ONE budget the person chooses, on the home screen and on the
/// lock screen — what is left to spend, and the ring.
///
/// ── FOUR SHAPES OF ONE WIDGET ───────────────────────────────────────────────
///
///   small        the name, what is left in large figures, the bar, and what
///                that is a day for the days left
///   circular     the lock-screen ring: how much is used, as a percentage
///   rectangular  the lock screen's three lines: name, what is left, a bar
///   inline       one line beside the date: "Groceries: £190 left"
///
/// The ring's centre is always the PERCENTAGE, never an amount. A lock screen
/// is read by whoever picks the phone up (the owner's concern, 9 Nov 2026), a
/// ring has room for three characters, and a percentage says how the budget
/// stands without saying how large it is. The rectangular and inline shapes
/// carry the server's own words, which are amounts or percentages by the
/// person's choice in Settings — and under "percentages only" no amount was
/// ever sent (`api/_lib/widget-budgets.ts`).
///
/// ── WHICH BUDGET ────────────────────────────────────────────────────────────
///
/// Chosen when the widget is edited, from the budgets running today. Until
/// one is chosen it is the first of the Dashboard's Key Budgets — so a widget
/// dropped on a screen and never configured still shows something chosen
/// rather than something arbitrary. A chosen budget that has since finished
/// or been deleted says so, and offers nothing in its place: silently drawing
/// a different budget under the same widget would be a wrong figure with the
/// right furniture.
///
/// ── THE SAME KEY, THE SAME DOCUMENT ─────────────────────────────────────────
///
/// It reads through `BudgetsSource`, as Key Budgets does: one fetch shape, one
/// cache, one answer to a key the server refuses. Like every figure here it
/// follows the person's reading of a long budget — so far, this month's
/// share, or whole — because the server shaped the document by it.
struct OneBudgetWidget: Widget {
    static let kind = "OneBudget"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: Self.kind, intent: ChooseBudgetIntent.self, provider: OneBudgetProvider()) { entry in
            OneBudgetView(entry: entry)
        }
        .configurationDisplayName("Budget")
        .description("One budget you choose: what is left to spend.")
        .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

// MARK: - Choosing the budget

struct BudgetChoice: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Budget"
    static let defaultQuery = BudgetChoiceQuery()

    let id: String
    let name: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }
}

struct BudgetChoiceQuery: EntityQuery {
    /// The budgets running today, Key Budgets first — the document's own order.
    private func running() async -> [BudgetChoice] {
        guard case .document(let document, _) = await BudgetsSource.load() else { return [] }
        return document.budgets.map { BudgetChoice(id: $0.id, name: $0.name) }
    }

    func entities(for identifiers: [String]) async throws -> [BudgetChoice] {
        let known = await running()
        // A chosen budget the server no longer lists keeps its place in the
        // configuration under a plain name, so the widget can say it is gone
        // rather than the editor forgetting what was picked.
        return identifiers.map { id in known.first { $0.id == id } ?? BudgetChoice(id: id, name: "A budget that is not running") }
    }

    func suggestedEntities() async throws -> [BudgetChoice] {
        await running()
    }
}

struct ChooseBudgetIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Budget"
    static let description = IntentDescription("Choose which budget this widget shows.")

    @Parameter(title: "Budget")
    var budget: BudgetChoice?
}

// MARK: - The timeline

struct OneBudgetEntry: TimelineEntry {
    enum Content: Equatable {
        case needsKey
        case unreachable
        /// The person has no budget running today at all.
        case none(hasBudgets: Bool)
        /// The budget chosen for this widget is not among those running.
        case gone
        case budget(BudgetsDocument.Budget, hideWhenLocked: Bool, staleSince: Date?)
    }

    let date: Date
    let content: Content
}

struct OneBudgetProvider: AppIntentTimelineProvider {
    private static let refreshEvery: TimeInterval = 30 * 60

    func placeholder(in context: Context) -> OneBudgetEntry {
        Self.sampleEntry
    }

    func snapshot(for configuration: ChooseBudgetIntent, in context: Context) async -> OneBudgetEntry {
        // The gallery draws an invented budget, never the person's own.
        if context.isPreview { return Self.sampleEntry }
        return await Self.entry(for: configuration)
    }

    func timeline(for configuration: ChooseBudgetIntent, in context: Context) async -> Timeline<OneBudgetEntry> {
        let entry = await Self.entry(for: configuration)
        return Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(Self.refreshEvery)))
    }

    private static var sampleEntry: OneBudgetEntry {
        OneBudgetEntry(date: Date(), content: .budget(BudgetsDocument.sample.budgets[0], hideWhenLocked: false, staleSince: nil))
    }

    static func entry(for configuration: ChooseBudgetIntent, now: Date = Date()) async -> OneBudgetEntry {
        switch await BudgetsSource.load(now: now) {
        case .needsKey:
            return OneBudgetEntry(date: now, content: .needsKey)
        case .unreachable:
            return OneBudgetEntry(date: now, content: .unreachable)
        case .document(let document, let staleSince):
            return OneBudgetEntry(date: now, content: pick(configuration.budget?.id, from: document, staleSince: staleSince))
        }
    }

    /// The chosen budget; with none chosen, the first Key Budget. Never a stand-in for a chosen one that has gone.
    static func pick(_ chosen: String?, from document: BudgetsDocument, staleSince: Date?) -> OneBudgetEntry.Content {
        if let chosen {
            guard let found = document.budgets.first(where: { $0.id == chosen }) else { return .gone }
            return .budget(found, hideWhenLocked: document.hideWhenLocked, staleSince: staleSince)
        }
        guard let first = document.forKeyBudgetsWidget.first else { return .none(hasBudgets: document.hasBudgets) }
        return .budget(first, hideWhenLocked: document.hideWhenLocked, staleSince: staleSince)
    }
}

// MARK: - Drawing

struct OneBudgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: OneBudgetEntry

    var body: some View {
        switch family {
        case .accessoryCircular:
            ring.containerBackground(for: .widget) { AccessoryWidgetBackground() }
        case .accessoryRectangular:
            rectangular.containerBackground(for: .widget) { Color.clear }
        case .accessoryInline:
            inline.containerBackground(for: .widget) { Color.clear }
        default:
            small.containerBackground(Palette.navy, for: .widget)
        }
    }

    /// What to say when there is no budget to draw. Short: the lock screen has a line or two.
    private var words: String? {
        switch entry.content {
        case .needsKey: return "Turn on budget widgets in Reckley, under Settings."
        case .unreachable: return "Could not reach Reckley."
        case .none(let hasBudgets): return hasBudgets ? "No budget is running today." : "No budgets yet."
        case .gone: return "That budget is not running. Edit this widget to choose another."
        case .budget: return nil
        }
    }

    private var shown: (budget: BudgetsDocument.Budget, hide: Bool, staleSince: Date?)? {
        if case .budget(let budget, let hide, let staleSince) = entry.content { return (budget, hide, staleSince) }
        return nil
    }

    // ── Home screen, small ──────────────────────────────────────────────────

    private var small: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let shown {
                HStack(alignment: .firstTextBaseline) {
                    Text(shown.budget.name)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Palette.quiet)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if let staleSince = shown.staleSince {
                        Text(staleSince, style: .time)
                            .font(.caption2)
                            .foregroundStyle(Palette.quiet)
                    }
                }
                Spacer(minLength: 6)
                Group {
                    Text(shown.budget.status)
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(Palette.mark(for: shown.budget.attention))
                        .minimumScaleFactor(0.6)
                        .lineLimit(2)
                    Spacer(minLength: 6)
                    BudgetBar(budget: shown.budget)
                    Text(detail(for: shown.budget))
                        .font(.caption2)
                        .foregroundStyle(Palette.quiet)
                        .lineLimit(1)
                        .padding(.top, 5)
                }
                .privacySensitive(shown.hide)
            } else {
                Text("Budget")
                    .font(.caption2.weight(.semibold))
                    .textCase(.uppercase)
                    .foregroundStyle(Palette.quiet)
                Spacer(minLength: 6)
                Text(words ?? "")
                    .font(.footnote)
                    .foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// "£18 a day · 12 days left" — the server's "a day" when it sent one, and always the days.
    private func detail(for budget: BudgetsDocument.Budget) -> String {
        let days = budget.daysLeft == 1 ? "last day" : "\(budget.daysLeft) days left"
        if let perDay = budget.perDay { return "\(perDay) · \(days)" }
        return days
    }

    // ── Lock screen ─────────────────────────────────────────────────────────

    private var ring: some View {
        Group {
            if let shown {
                Gauge(value: min(max(shown.budget.percent, 0), 100), in: 0...100) {
                    Text(shown.budget.name)
                } currentValueLabel: {
                    Text("\(Int(shown.budget.percent.rounded()))%")
                }
                .gaugeStyle(.accessoryCircularCapacity)
                .privacySensitive(shown.hide)
                .accessibilityLabel("\(shown.budget.name): \(shown.budget.status)")
            } else {
                // No room for words in a ring: the mark, and the other shapes say why.
                Image(systemName: "chart.pie")
                    .font(.title3)
                    .accessibilityLabel(words ?? "Budget")
            }
        }
    }

    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let shown {
                Text(shown.budget.name)
                    .font(.headline)
                    .lineLimit(1)
                    .widgetAccentable()
                Group {
                    Text(shown.budget.status)
                        .font(.subheadline)
                        .lineLimit(1)
                    ProgressView(value: min(max(shown.budget.percent, 0), 100), total: 100)
                        .progressViewStyle(.linear)
                }
                .privacySensitive(shown.hide)
            } else {
                Text("Reckley").font(.headline).widgetAccentable()
                Text(words ?? "")
                    .font(.caption)
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var inline: some View {
        Group {
            if let shown {
                Text("\(shown.budget.name): \(shown.budget.status)").privacySensitive(shown.hide)
            } else {
                Text(words ?? "Reckley")
            }
        }
    }
}
