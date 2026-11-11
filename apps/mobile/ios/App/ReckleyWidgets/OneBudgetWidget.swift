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
///   rectangular  the lock screen's three lines: name, how much is used, a bar
///   inline       one line beside the date: "Groceries: 62% used"
///
/// ── NO AMOUNT IS EVER DRAWN ON THE LOCK SCREEN ──────────────────────────────
///
/// A lock screen is read by whoever picks the phone up (the owner's concern,
/// 9 Nov 2026), so all three lock-screen shapes say how the budget stands as
/// a PERCENTAGE and never as money, whatever the person chose in Settings.
/// The first build of this widget (9) did that for the ring only and let the
/// rectangle and the line carry the server's words, which are amounts by
/// default: the owner's lock screen showed what was left of a budget in
/// pounds within minutes of his installing it (11 Nov 2026). "Amounts or
/// percentages" in Settings is a choice about the HOME screen, which is
/// behind the lock; the lock screen does not get to ask.
///
/// The words are made here, from the one number the document carries for
/// drawing — `percent` — in the server's own phrasings ("62% used" or, by the
/// person's choice in Settings, "38% left"; "Over by 12%" either way;
/// `api/_lib/widget-budgets.ts`). The ring follows the same choice: it fills
/// with what is used, or stands for what is left and empties. That is the only sentence
/// this widget composes, and it has no money in it to get wrong.
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
    /// The person asked for percentages as what is LEFT, not what is used.
    var percentAsLeft = false
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
            return OneBudgetEntry(
                date: now,
                content: pick(configuration.budget?.id, from: document, staleSince: staleSince),
                percentAsLeft: document.percentAs == "left"
            )
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

    /// How the budget stands, with no amount in it — see the header. The
    /// server's own two phrasings, from the one number it sends for drawing.
    static func lockScreenWords(for budget: BudgetsDocument.Budget, asLeft: Bool) -> String {
        if budget.attention == "over" || budget.percent > 100 {
            return "Over by \(max(1, Int((budget.percent - 100).rounded())))%"
        }
        return asLeft ? "\(percentLeft(of: budget))% left" : "\(Int(budget.percent.rounded()))% used"
    }

    /// What remains, never below nothing: the complement of the rounded figure
    /// "used" would show, so the two readings of one budget always sum to 100.
    static func percentLeft(of budget: BudgetsDocument.Budget) -> Int {
        max(0, 100 - Int(budget.percent.rounded()))
    }

    /// The ring's fill and its centre: what is used and filling, or what is
    /// left and emptying. An overspent budget is a full ring saying how far
    /// past, or an empty one saying nothing is left.
    private func ringFigures(for budget: BudgetsDocument.Budget) -> (value: Double, label: String) {
        if entry.percentAsLeft {
            return (min(max(100 - budget.percent, 0), 100), "\(Self.percentLeft(of: budget))%")
        }
        return (min(max(budget.percent, 0), 100), "\(Int(budget.percent.rounded()))%")
    }

    private var ring: some View {
        Group {
            if let shown {
                let figures = ringFigures(for: shown.budget)
                Gauge(value: figures.value, in: 0...100) {
                    Text(shown.budget.name)
                } currentValueLabel: {
                    Text(figures.label)
                }
                .gaugeStyle(.accessoryCircularCapacity)
                .privacySensitive(shown.hide)
                .accessibilityLabel("\(shown.budget.name): \(Self.lockScreenWords(for: shown.budget, asLeft: entry.percentAsLeft))")
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
                    Text(Self.lockScreenWords(for: shown.budget, asLeft: entry.percentAsLeft))
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
                Text("\(shown.budget.name): \(Self.lockScreenWords(for: shown.budget, asLeft: entry.percentAsLeft))").privacySensitive(shown.hide)
            } else {
                Text(words ?? "Reckley")
            }
        }
    }
}
