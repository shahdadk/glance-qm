import Foundation

public enum MeetingAPIError: Error, Equatable, Sendable {
    case invalidBaseURL
    case insecureBaseURL
    case missingToken
    case invalidIdentifier
    case invalidResponse
    case httpStatus(Int)
    case eventMeetingMismatch
    case unsupportedMessage
}

extension MeetingAPIError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .invalidBaseURL:
            return "The meeting service URL is invalid."
        case .insecureBaseURL:
            return "Use HTTPS, or HTTP on localhost/private LAN only."
        case .missingToken:
            return "A meeting service token is required."
        case .invalidIdentifier:
            return "The meeting identifier is invalid."
        case .invalidResponse:
            return "The meeting service returned an invalid response."
        case .httpStatus(let status):
            return "The meeting service returned HTTP \(status)."
        case .eventMeetingMismatch:
            return "The WebSocket event belongs to another meeting."
        case .unsupportedMessage:
            return "The meeting service sent an unsupported WebSocket message."
        }
    }
}

/// Authenticated client for the small, versioned Glance QM HTTP/WebSocket
/// boundary. The token is held in memory only and is never added to a URL.
public actor MeetingAPI {
    public let baseURL: URL

    private let token: String
    private let session: URLSession
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    /// The initializer rejects credentials embedded in the URL and rejects
    /// public HTTP endpoints. HTTPS can be used with a hosted service; HTTP is
    /// intentionally limited to localhost and private/link-local LAN hosts.
    public init(baseURL: URL, token: String, session: URLSession = .shared) throws {
        guard Self.isValidBackendURL(baseURL) else {
            guard Self.hasAllowedHTTPHost(baseURL) else {
                throw MeetingAPIError.insecureBaseURL
            }
            throw MeetingAPIError.invalidBaseURL
        }
        let normalizedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedToken.isEmpty else { throw MeetingAPIError.missingToken }

        var normalized = baseURL
        normalized = normalized.resolvingSymlinksInPath()
        // A query or fragment has already been rejected above. Removing a
        // trailing slash keeps path construction deterministic.
        if normalized.path.hasSuffix("/") && normalized.path.count > 1 {
            var components = URLComponents(url: normalized, resolvingAgainstBaseURL: false)
            let trimmedPath = String((components?.path ?? "").dropLast())
            components?.path = trimmedPath
            normalized = components?.url ?? normalized
        }

        self.baseURL = normalized
        self.token = normalizedToken
        self.session = session
        self.encoder = JSONEncoder()
        self.decoder = JSONDecoder()
    }

    /// Convenience initializer for a value read from app configuration.
    public init(baseURLString: String, token: String, session: URLSession = .shared) throws {
        guard let url = URL(string: baseURLString) else {
            throw MeetingAPIError.invalidBaseURL
        }
        try self.init(baseURL: url, token: token, session: session)
    }

    // MARK: HTTP

    public func createMeeting(
        title: String,
        participantNames: [String]? = nil
    ) async throws -> MeetingSnapshot {
        let body = try encoder.encode(CreateMeetingRequest(title: title, participantNames: participantNames))
        return try await request(method: "POST", path: ["api", "meetings"], body: body)
    }

    public func snapshot(id: String) async throws -> MeetingSnapshot {
        try validateIdentifier(id)
        return try await request(method: "GET", path: ["api", "meetings", id])
    }

    public func appendTranscript(
        id: String,
        segment: TranscriptSubmission
    ) async throws -> MeetingSnapshot {
        try validateIdentifier(id)
        let body = try encoder.encode(segment)
        return try await request(method: "POST", path: ["api", "meetings", id, "transcript"], body: body)
    }

    public func end(id: String) async throws -> MeetingSnapshot {
        try validateIdentifier(id)
        return try await request(method: "POST", path: ["api", "meetings", id, "end"])
    }

    /// Pauses or resumes the active meeting through the backend control route.
    public func control(id: String, action: MeetingControlAction) async throws -> MeetingSnapshot {
        try validateIdentifier(id)
        let body = try encoder.encode(MeetingControlRequest(action: action))
        return try await request(method: "POST", path: ["api", "meetings", id, "control"], body: body)
    }

    public func pause(id: String) async throws -> MeetingSnapshot {
        try await control(id: id, action: .pause)
    }

    public func resume(id: String) async throws -> MeetingSnapshot {
        try await control(id: id, action: .resume)
    }

    /// Convenience mapping for UI state. Ending remains a distinct endpoint so
    /// that summary/follow-up work is started by the server only once.
    public func setStatus(id: String, status: MeetingStatus) async throws -> MeetingSnapshot {
        switch status {
        case .listening:
            return try await resume(id: id)
        case .paused:
            return try await pause(id: id)
        case .ended:
            return try await end(id: id)
        }
    }

    public func confirm(
        id: String,
        actionId: String,
        proposalVersion: Int
    ) async throws -> MeetingSnapshot {
        try validateIdentifier(id)
        try validateIdentifier(actionId)
        let body = try encoder.encode(ConfirmActionRequest(proposalVersion: proposalVersion))
        return try await request(
            method: "POST",
            path: ["api", "meetings", id, "actions", actionId, "confirm"],
            body: body
        )
    }

    /// Marks a generated document as reviewed for the exact task generation
    /// and context digest shown to the operator.
    public func reviewTask(
        id: String,
        taskId: String,
        generation: Int,
        contextDigest: String
    ) async throws -> MeetingSnapshot {
        try validateIdentifier(id)
        try validateIdentifier(taskId)
        let body = try encoder.encode(ReviewTaskRequest(generation: generation, contextDigest: contextDigest))
        return try await request(
            method: "POST",
            path: ["api", "meetings", id, "tasks", taskId, "review"],
            body: body
        )
    }

    /// Creates a reviewable self-recipient delivery preview for a completed
    /// document task. The server resolves the connected mailbox.
    public func proposeDelivery(id: String, taskId: String) async throws -> MeetingSnapshot {
        try validateIdentifier(id)
        try validateIdentifier(taskId)
        let body = try encoder.encode(ProposeDeliveryRequest())
        return try await request(
            method: "POST",
            path: ["api", "meetings", id, "tasks", taskId, "delivery"],
            body: body
        )
    }

    /// Sends the exact previously reviewed delivery proposal version.
    public func confirmDelivery(
        id: String,
        deliveryId: String,
        proposalVersion: Int
    ) async throws -> MeetingSnapshot {
        try validateIdentifier(id)
        try validateIdentifier(deliveryId)
        let body = try encoder.encode(ConfirmDeliveryRequest(proposalVersion: proposalVersion))
        return try await request(
            method: "POST",
            path: ["api", "meetings", id, "deliveries", deliveryId, "confirm"],
            body: body
        )
    }

    // MARK: WebSocket

    /// Opens the meeting event stream. Authentication is sent as the first
    /// WebSocket message; the token is never placed in the URL.
    public func events(id: String) -> AsyncThrowingStream<MeetingEvent, Error> {
        do {
            try validateIdentifier(id)
        } catch {
            return AsyncThrowingStream { continuation in
                continuation.finish(throwing: error)
            }
        }

        let expectedMeetingID = id
        let session = self.session
        let token = self.token
        let baseURL = self.baseURL
        let encoder = self.encoder
        let decoder = self.decoder

        return AsyncThrowingStream { continuation in
            let webSocketTask: URLSessionWebSocketTask
            do {
                let url = try Self.makeWebSocketURL(
                    baseURL: baseURL,
                    path: ["api", "meetings", expectedMeetingID, "events"]
                )
                var request = URLRequest(url: url)
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                request.setValue("application/json", forHTTPHeaderField: "Accept")
                webSocketTask = session.webSocketTask(with: request)
            } catch {
                continuation.finish(throwing: error)
                return
            }
            webSocketTask.resume()

            let worker = _Concurrency.Task {
                do {
                    let auth = try encoder.encode(WebSocketAuthMessage(token: token))
                    guard let authMessage = String(data: auth, encoding: .utf8) else {
                        throw MeetingAPIError.invalidResponse
                    }
                    try await webSocketTask.send(.string(authMessage))

                    while !_Concurrency.Task.isCancelled {
                        let message = try await webSocketTask.receive()
                        let data: Data
                        switch message {
                        case .string(let string):
                            guard let stringData = string.data(using: .utf8) else {
                                throw MeetingAPIError.invalidResponse
                            }
                            data = stringData
                        case .data(let receivedData):
                            data = receivedData
                        @unknown default:
                            throw MeetingAPIError.unsupportedMessage
                        }

                        let envelope = try decoder.decode(MeetingEventEnvelope.self, from: data)
                        guard envelope.meetingId == expectedMeetingID else {
                            throw MeetingAPIError.eventMeetingMismatch
                        }
                        continuation.yield(envelope.event)
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
                webSocketTask.cancel(with: .goingAway, reason: nil)
            }

            continuation.onTermination = { @Sendable _ in
                worker.cancel()
                webSocketTask.cancel(with: .goingAway, reason: nil)
            }
        }
    }

    // MARK: Request construction

    private func request<Response: Decodable>(
        method: String,
        path: [String],
        body: Data? = nil
    ) async throws -> Response {
        let url = try Self.makeURL(baseURL: baseURL, path: path)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 12
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let operation = path.count <= 2 ? "createMeeting" : (path.count == 3 ? "snapshot" : (path.last ?? "request"))
        await NativeDiagnostics.record(["networkOperation": operation, "networkStartedAt": ISO8601DateFormatter().string(from: Date()), "networkHost": baseURL.host ?? "", "networkErrorCode": "", "networkHTTPStatus": ""])
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch {
            let failure = error as NSError
            await NativeDiagnostics.record(["networkErrorDomain": failure.domain, "networkErrorCode": String(failure.code), "networkFailedAt": ISO8601DateFormatter().string(from: Date())])
            throw error
        }
        guard let httpResponse = response as? HTTPURLResponse else {
            throw MeetingAPIError.invalidResponse
        }
        await NativeDiagnostics.record(["networkHTTPStatus": String(httpResponse.statusCode), "networkCompletedAt": ISO8601DateFormatter().string(from: Date())])
        guard (200...299).contains(httpResponse.statusCode) else {
            // Do not include a server body in errors: a misconfigured server
            // must not be able to echo the bearer token into app logs/UI.
            throw MeetingAPIError.httpStatus(httpResponse.statusCode)
        }
        guard !data.isEmpty else { throw MeetingAPIError.invalidResponse }
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw MeetingAPIError.invalidResponse
        }
    }

    private static func makeURL(baseURL: URL, path: [String]) throws -> URL {
        guard let url = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              url.query == nil,
              url.fragment == nil,
              url.user == nil,
              url.password == nil else {
            throw MeetingAPIError.invalidBaseURL
        }

        guard !path.isEmpty else { return baseURL }
        var result = url.url ?? baseURL
        for component in path {
            result.appendPathComponent(component, isDirectory: false)
        }
        return result
    }

    private static func makeWebSocketURL(baseURL: URL, path: [String]) throws -> URL {
        let httpURL = try makeURL(baseURL: baseURL, path: path)
        guard var components = URLComponents(url: httpURL, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased() else {
            throw MeetingAPIError.invalidBaseURL
        }
        switch scheme {
        case "http": components.scheme = "ws"
        case "https": components.scheme = "wss"
        default: throw MeetingAPIError.invalidBaseURL
        }
        guard let webSocketURL = components.url else { throw MeetingAPIError.invalidBaseURL }
        return webSocketURL
    }

    private static func isValidBackendURL(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(),
              let host = components.host,
              !host.isEmpty,
              components.query == nil,
              components.fragment == nil,
              components.user == nil,
              components.password == nil else {
            return false
        }

        if scheme == "https" { return true }
        if scheme == "http" { return hasAllowedHTTPHost(url) }
        return false
    }

    private static func hasAllowedHTTPHost(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == "http",
              let rawHost = components.host?.lowercased(),
              !rawHost.isEmpty else {
            return false
        }
        let host = rawHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host == "localhost" || host.hasSuffix(".local") { return true }
        if let octets = ipv4Octets(host) {
            if octets[0] == 10 || octets[0] == 127 { return true }
            if octets[0] == 169 && octets[1] == 254 { return true }
            if octets[0] == 172 && (16...31).contains(octets[1]) { return true }
            if octets[0] == 192 && octets[1] == 168 { return true }
            return false
        }
        if host.contains(":"), let firstGroup = host.split(separator: ":", omittingEmptySubsequences: true).first,
           let prefix = UInt16(firstGroup, radix: 16) {
            if host == "::1" { return true }
            if (0xfc00...0xfdff).contains(prefix) || (0xfe80...0xfebf).contains(prefix) { return true }
        }
        return false
    }

    private static func ipv4Octets(_ host: String) -> [Int]? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        guard parts.allSatisfy({ !$0.isEmpty && $0.allSatisfy({ $0 >= "0" && $0 <= "9" }) }) else { return nil }
        let values = parts.compactMap { Int($0) }
        guard values.count == 4, values.allSatisfy({ (0...255).contains($0) }) else { return nil }
        return values
    }

    private func validateIdentifier(_ id: String) throws {
        guard !id.isEmpty, id.count <= 100,
              id.unicodeScalars.allSatisfy({ scalar in
                  (scalar.value >= 48 && scalar.value <= 57) ||
                  (scalar.value >= 65 && scalar.value <= 90) ||
                  (scalar.value >= 97 && scalar.value <= 122) ||
                  scalar.value == 45 || scalar.value == 95
              }) else {
            throw MeetingAPIError.invalidIdentifier
        }
    }
}
