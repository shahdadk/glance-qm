import Foundation

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
