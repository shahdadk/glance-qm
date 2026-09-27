import XCTest
@testable import GlanceQM
final class InitialTests: XCTestCase {
    func testBundle() { XCTAssertEqual(Bundle.main.bundleIdentifier, "com.shahdad.glanceqm") }
}
