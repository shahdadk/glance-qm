import XCTest
@testable import GlanceQM
final class DisplayPaginationTests: XCTestCase {
    func testContextCardRetainsPossibleMatchQualifierAndAllBullets() {
        let text = "Possible match: A Person · Company\n• First fact.\n• Second fact.\n• Third fact."
        let card = ContextCardContent(text: text)
        XCTAssertEqual(card.heading, "Possible match: A Person · Company")
        XCTAssertEqual(card.rows, ["• First fact.", "• Second fact.", "• Third fact."])
        XCTAssertEqual(([card.heading!] + card.rows).joined(separator: "\n"), text)
    }
    func testContextCardKeepsGeneralCueAndBulletOnlyContent() {
        let prose = "A useful thought.\nIts supporting context."
        XCTAssertNil(ContextCardContent(text: prose).heading)
        XCTAssertEqual(ContextCardContent(text: prose).rows.joined(separator: "\n"), prose)
        let bullets = "• First fact.\n• Second fact."
        XCTAssertNil(ContextCardContent(text: bullets).heading)
        XCTAssertEqual(ContextCardContent(text: bullets).rows.joined(separator: "\n"), bullets)
    }
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
