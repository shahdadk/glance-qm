import Foundation

/// Operator-requested local demo brief. This is saved company copy, not a live lookup.
enum PreloadedCompanyBrief {
    static let title = "Liquid Energy"
    static let body = "• Modular AI compute\n• High-density air cooling\n• Adaptive thermal controls"
    static let sourceURL = "https://www.liquidenergy.world/"
    static let provenance = "Preloaded brief · liquidenergy.world"
}

/// Presentation only: keeps uncertainty qualifiers and every fact supplied by the server.
struct ContextCardContent: Equatable {
    let heading: String?
    let rows: [String]

    init(text: String) {
        var lines = text.components(separatedBy: "\n")
        if lines.count > 1, lines.dropFirst().contains(where: { $0.hasPrefix("•") }),
           let first = lines.first, !first.isEmpty, !first.hasPrefix("•") {
            heading = lines.removeFirst()
        } else { heading = nil }
        rows = lines
    }
}

/// Small deterministic pages; exact calendar details remain available before confirmation.
struct DisplayPagination: Equatable {
    let pages: [String]
    private(set) var index = 0
    init(text: String, maximumCharacters: Int = 280) {
        let limit = max(40, maximumCharacters)
        var remaining = text[...]
        var result: [String] = []
        while !remaining.isEmpty {
            if remaining.count <= limit { result.append(String(remaining)); break }
            let proposedEnd = remaining.index(remaining.startIndex, offsetBy: limit)
            let prefix = remaining[..<proposedEnd]
            let end = prefix.lastIndex(where: { $0.isWhitespace }) ?? proposedEnd
            let safeEnd = end == remaining.startIndex ? proposedEnd : end
            result.append(String(remaining[..<safeEnd]))
            remaining = remaining[safeEnd...].drop(while: { $0.isWhitespace })
        }
        pages = result.isEmpty ? ["No details yet."] : result
    }
    var current: String { pages[index] }
    var isLast: Bool { index == pages.count - 1 }
    mutating func next() { if !isLast { index += 1 } }
}
