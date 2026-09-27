import XCTest
@testable import GlanceQM
final class DisplayPaginationTests: XCTestCase {
    func testDetailsMustReachLastPageBeforeConfirmation() {
        var pager = DisplayPagination(text: String(repeating: "meeting details ", count: 50), maximumCharacters: 80)
        XCTAssertFalse(pager.isLast)
        XCTAssertTrue(pager.pages.allSatisfy { $0.count <= 80 })
        while !pager.isLast { pager.next() }
        let index = pager.index
        pager.next()
        XCTAssertEqual(index, pager.index)
    }
    func testSingleLongWordMakesProgress() {
        let pager = DisplayPagination(text: String(repeating: "x", count: 240), maximumCharacters: 80)
        XCTAssertEqual(pager.pages.count, 3)
        XCTAssertEqual(pager.pages.joined(), String(repeating: "x", count: 240))
    }
    func testEmptyContentIsUsable() { XCTAssertEqual(DisplayPagination(text: "").pages.count, 1) }
}
