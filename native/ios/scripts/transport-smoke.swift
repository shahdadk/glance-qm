import Foundation

@main
struct NativeTransportSmoke {
    static func main() async throws {
        guard CommandLine.arguments.count == 2 else { throw NSError(domain: "Pass private pairing.json path", code: 1) }
        struct Pairing: Decodable { let serverURL: String; let operatorToken: String }
        let pairing = try JSONDecoder().decode(Pairing.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
        let api = try MeetingAPI(baseURLString: pairing.serverURL, token: pairing.operatorToken)
        let meeting = try await api.createMeeting(title: "Native transport verification", participantNames: ["Test participant"])
        print("Created native transport meeting \(meeting.id)")
        let events = await api.events(id: meeting.id)
        let firstSnapshot = Task { () throws -> Bool in
            for try await event in events { if case .snapshot(let value) = event { return value.id == meeting.id } }
            return false
        }
        let timeout = Task { try await Task.sleep(for: .seconds(10)); firstSnapshot.cancel() }
        defer { timeout.cancel(); firstSnapshot.cancel() }
        guard try await firstSnapshot.value else { throw NSError(domain: "No authenticated WebSocket snapshot", code: 2) }
        print("Authenticated native WebSocket snapshot received")
        var tracker = TranscriptRevisionTracker()
        let partial = tracker.submit(text: "We are verifying", isFinal: false)!
        _ = try await api.appendTranscript(id: meeting.id, segment: partial)
        let final = tracker.submit(text: "We are verifying the native meeting transport. No invitation or document is requested.", isFinal: true)!
        let finalState = try await api.appendTranscript(id: meeting.id, segment: final)
        let duplicate = try await api.appendTranscript(id: meeting.id, segment: final)
        guard finalState.transcript.count == 1, duplicate.transcript.count == 1 else { throw NSError(domain: "Transcript revision dedup failed", code: 3) }
        print("Partial/final revision and duplicate retry verified")
        _ = try await api.control(id: meeting.id, action: .pause)
        let resumed = try await api.control(id: meeting.id, action: .resume)
        guard resumed.status == .listening else { throw NSError(domain: "Control failed", code: 4) }
        let ended = try await api.end(id: meeting.id)
        guard ended.status == .ended else { throw NSError(domain: "End failed", code: 5) }
        print("Pause/resume/end verified. No external action confirmed.")
    }
}
