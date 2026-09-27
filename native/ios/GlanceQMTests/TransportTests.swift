import Foundation
import XCTest
@testable import GlanceQM

final class TransportTests: XCTestCase {
    func testTypedEventDecodingKeepsMeetingIDAndPayload() throws {
        let data = Data(
            ##"{"type":"transcript","meetingId":"meeting-1","payload":{"id":"segment-1","text":"hello","isFinal":true,"revision":2,"capturedAt":"2026-09-27T20:00:00Z"}}"##.utf8
        )

        let envelope = try JSONDecoder().decode(MeetingEventEnvelope.self, from: data)
        XCTAssertEqual(envelope.meetingId, "meeting-1")
        guard case .transcript(let segment) = envelope.event else {
            return XCTFail("Expected transcript event")
        }
        XCTAssertEqual(segment.id, "segment-1")
        XCTAssertEqual(segment.text, "hello")
        XCTAssertTrue(segment.isFinal)
        XCTAssertEqual(segment.revision, 2)
    }

    func testReviewRequiredTaskAndDeliveryEventDecode() throws {
        let snapshotData = Data(
            ##"{"id":"meeting-1","title":"Planning","status":"ended","revision":7,"participants":[],"transcript":[],"tasks":[{"id":"task-1","title":"Brief","status":"review_required","content":"# Brief","generation":2,"artifactDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","contextDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","origin":{"meetingId":"meeting-1","revision":7,"contextRevision":3,"contextDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","correctionEpoch":1,"lastSegmentId":"segment-1","finalCount":2,"capturedAt":1727467200}}],"deliveryAction":{"id":"delivery-1","proposalVersion":1,"taskId":"task-1","generation":2,"artifactDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","contextDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","recipient":{"email":"operator@example.com","name":"Operator"},"subject":"Brief","body":"Please find the reviewed document attached.","filename":"document.md","contentType":"text/markdown; charset=utf-8","status":"proposed"},"createdAt":"2026-09-27T20:00:00Z","updatedAt":"2026-09-27T20:00:00Z"}"##.utf8
        )

        let snapshot = try JSONDecoder().decode(MeetingSnapshot.self, from: snapshotData)
        XCTAssertEqual(snapshot.tasks.first?.status, .reviewRequired)
        XCTAssertEqual(snapshot.tasks.first?.generation, 2)
        XCTAssertEqual(snapshot.deliveryAction?.id, "delivery-1")
        XCTAssertEqual(snapshot.deliveryAction?.status, .proposed)

        let eventData = Data(
            ##"{"type":"delivery","meetingId":"meeting-1","payload":{"deliveryAction":{"id":"delivery-1","proposalVersion":1,"taskId":"task-1","generation":2,"artifactDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","contextDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","recipient":{"email":"operator@example.com"},"subject":"Brief","body":"Please find the reviewed document attached.","filename":"document.md","contentType":"text/markdown; charset=utf-8","status":"proposed"}}}"##.utf8
        )
        let envelope = try JSONDecoder().decode(MeetingEventEnvelope.self, from: eventData)
        guard case .delivery(let action) = envelope.event else {
            return XCTFail("Expected delivery event")
        }
        XCTAssertEqual(action.taskId, "task-1")
        XCTAssertEqual(action.contentType, "text/markdown; charset=utf-8")
    }

    func testTranscriptRevisionsUseStableIDsAndDropRepeatedFinal() {
        var identifiers = ["utterance-1", "utterance-2"]
        var tracker = TranscriptRevisionTracker {
            identifiers.removeFirst()
        }

        let first = tracker.submit(text: " hello ", isFinal: false)
        let revision = tracker.submit(text: "hello world", isFinal: false)
        let final = tracker.submit(text: "hello world", isFinal: true)
        let duplicateFinal = tracker.submit(text: "hello world", isFinal: true)
        let nextUtterance = tracker.submit(text: "next thought", isFinal: false)

        XCTAssertEqual(first?.segmentId, "utterance-1")
        XCTAssertEqual(first?.revision, 0)
        XCTAssertEqual(first?.text, "hello")
        XCTAssertEqual(revision?.segmentId, first?.segmentId)
        XCTAssertEqual(revision?.revision, 1)
        XCTAssertEqual(final?.segmentId, first?.segmentId)
        XCTAssertEqual(final?.revision, 2)
        XCTAssertNil(duplicateFinal)
        XCTAssertEqual(nextUtterance?.segmentId, "utterance-2")
        XCTAssertEqual(nextUtterance?.revision, 0)
    }

    func testHTTPBearerAuthIsInHeaderAndNeverURL() async throws {
        let token = "secret-token-that-must-not-be-in-a-url"
        let snapshot = Data(
            ##"{"id":"meeting-1","title":"Planning","status":"listening","revision":0,"participants":[],"transcript":[],"tasks":[],"createdAt":"2026-09-27T20:00:00Z","updatedAt":"2026-09-27T20:00:00Z"}"##.utf8
        )

        let capturedRequest = RequestBox()
        StubURLProtocol.handler = { request in
            capturedRequest.store(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, snapshot)
        }
        defer { StubURLProtocol.handler = nil }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        let api = try MeetingAPI(
            baseURL: URL(string: "http://127.0.0.1:8790")!,
            token: token,
            session: URLSession(configuration: configuration)
        )

        let result = try await api.snapshot(id: "meeting-1")
        XCTAssertEqual(result.id, "meeting-1")

        let request = capturedRequest.load()
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Authorization"), "Bearer \(token)")
        XCTAssertEqual(request?.url?.path, "/api/meetings/meeting-1")
        XCTAssertFalse(request?.url?.absoluteString.contains(token) == true)
        XCTAssertNil(request?.url?.query)
        XCTAssertNil(request?.url?.fragment)
    }

    func testBareHexHostnameIsNotTreatedAsPrivateIPv6() {
        XCTAssertThrowsError(try MeetingAPI(baseURLString: "http://fc00:8790", token: "test-token"))
        XCTAssertNoThrow(try MeetingAPI(baseURLString: "http://[fd00::1]:8790", token: "test-token"))
    }

    func testPublicHTTPBackendIsRejected() {
        XCTAssertThrowsError(
            try MeetingAPI(baseURL: URL(string: "http://example.com:8790")!, token: "token")
        ) { error in
            XCTAssertEqual(error as? MeetingAPIError, .insecureBaseURL)
        }
    }
}

private final class StubURLProtocol: URLProtocol {
    static var handler: ((URLRequest) -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler, let url = request.url else {
            client?.urlProtocol(self, didFailWithError: MeetingAPIError.invalidResponse)
            return
        }
        let (response, data) = handler(request)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
        _ = url
    }

    override func stopLoading() {}
}

private final class RequestBox: @unchecked Sendable {
    private let lock = NSLock()
    private var request: URLRequest?

    func store(_ request: URLRequest) {
        lock.lock()
        self.request = request
        lock.unlock()
    }

    func load() -> URLRequest? {
        lock.lock()
        defer { lock.unlock() }
        return request
    }
}
