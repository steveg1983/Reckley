import Foundation

/// The document `GET /api/widget/budgets` answers with (`api/_lib/widget-budgets.ts`, v1).
///
/// Every figure arrives as the words to draw. Nothing here adds, divides or
/// formats money: `percent` is the length of a bar and nothing else. Under
/// "percentages only" the amount fields are absent from the document, so they
/// are optional here and no layout may depend on them.
struct BudgetsDocument: Codable, Equatable {
    struct Budget: Codable, Equatable, Identifiable {
        let id: String
        let name: String
        let key: Bool
        let percent: Double
        let attention: String
        let status: String
        let period: String
        let until: String
        let daysLeft: Int
        let spent: String?
        let allowance: String?
        let perDay: String?
    }

    let v: Int
    let asOf: String
    let display: String
    let hideWhenLocked: Bool
    /// "used" or "left": how a percentage is said. Absent from a document made
    /// before the choice existed, which reads as "used".
    var percentAs: String? = nil
    let hasBudgets: Bool
    let budgets: [Budget]

    /// The Dashboard's Key Budgets, in the person's order; with none chosen, the budgets as stored.
    var forKeyBudgetsWidget: [Budget] {
        let chosen = budgets.filter(\.key)
        return chosen.isEmpty ? budgets : chosen
    }
}

enum BudgetsFetch {
    enum Outcome {
        case document(BudgetsDocument)
        /// The server no longer knows the key: revoked, or never valid.
        case refused
        case unreachable
    }

    /// The version this build draws. A later one is drawn only if it still decodes.
    static let version = 1

    static func run(with credential: WidgetCredential) async -> Outcome {
        guard var parts = URLComponents(string: credential.origin + "/api/widget/budgets") else { return .unreachable }
        parts.queryItems = [URLQueryItem(name: "tz", value: TimeZone.current.identifier)]
        guard let url = parts.url else { return .unreachable }

        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 15)
        request.setValue("Bearer \(credential.key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return .unreachable }
            if http.statusCode == 401 { return .refused }
            guard http.statusCode == 200 else { return .unreachable }
            return .document(try JSONDecoder().decode(BudgetsDocument.self, from: data))
        } catch {
            return .unreachable
        }
    }
}

/// The last document that arrived, kept in the extension's own container so a
/// refresh without a network draws something true-as-of rather than nothing.
/// Tied to the key it was fetched with: a different key, or none, reads nothing.
enum BudgetsCache {
    private static let documentKey = "lastBudgetsDocument"
    private static let ownerKey = "lastBudgetsDocumentKeyId"

    static func save(_ document: BudgetsDocument, for keyId: String, defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(document) else { return }
        defaults.set(data, forKey: documentKey)
        defaults.set(keyId, forKey: ownerKey)
    }

    static func read(for keyId: String, defaults: UserDefaults = .standard) -> BudgetsDocument? {
        guard defaults.string(forKey: ownerKey) == keyId,
              let data = defaults.data(forKey: documentKey) else { return nil }
        return try? JSONDecoder().decode(BudgetsDocument.self, from: data)
    }

    static func clear(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: documentKey)
        defaults.removeObject(forKey: ownerKey)
    }
}
