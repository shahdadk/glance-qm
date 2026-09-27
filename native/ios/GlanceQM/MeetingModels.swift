import Foundation

// MARK: - Shared meeting contract

/// The values are kept as strings on the wire so that the native client can
/// round-trip the versioned boundary without introducing date or URL policy.
public enum MeetingStatus: String, Codable, Equatable, Sendable {
    case listening
    case paused
    case ended
}

public enum ParticipantRole: String, Codable, Equatable, Sendable {
    case owner
    case participant
}

public struct Participant: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let role: ParticipantRole
    public let joinedAt: String

    public init(id: String, name: String, role: ParticipantRole, joinedAt: String) {
        self.id = id
        self.name = name
        self.role = role
        self.joinedAt = joinedAt
    }
}

public struct TranscriptSegment: Codable, Equatable, Sendable {
    public let id: String
    public let text: String
    public let isFinal: Bool
    public let revision: Int
    public let speaker: String?
    public let capturedAt: String

    public init(
        id: String,
        text: String,
        isFinal: Bool,
        revision: Int,
        speaker: String? = nil,
        capturedAt: String
    ) {
        self.id = id
        self.text = text
        self.isFinal = isFinal
        self.revision = revision
        self.speaker = speaker
        self.capturedAt = capturedAt
    }
}

/// The append endpoint intentionally omits `capturedAt`; the server records
/// that value when it accepts the submission. `segmentId` remains stable while
/// an SDK emits revisions for one utterance.
public struct TranscriptSubmission: Codable, Equatable, Sendable {
    public let segmentId: String
    public let text: String
    public let isFinal: Bool
    public let revision: Int
    public let speaker: String?

    public init(
        segmentId: String,
        text: String,
        isFinal: Bool,
        revision: Int,
        speaker: String? = nil
    ) {
        self.segmentId = segmentId
        self.text = text
        self.isFinal = isFinal
        self.revision = revision
        self.speaker = speaker
    }

    /// Convenience for code that treats the native submission like a segment.
    public var id: String { segmentId }
}

/// Name used by the TypeScript contract for the same append request.
public typealias AppendTranscriptRequest = TranscriptSubmission

public enum EvidenceKind: String, Codable, Equatable, Sendable {
    case transcript
    case memory
    case external
    case calculation
}

public struct Evidence: Codable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let text: String
    public let url: String?
    public let kind: EvidenceKind

    public init(
        id: String,
        label: String,
        text: String,
        url: String? = nil,
        kind: EvidenceKind
    ) {
        self.id = id
        self.label = label
        self.text = text
        self.url = url
        self.kind = kind
    }
}

public struct Cue: Codable, Equatable, Sendable {
    public let id: String
    public let text: String
    public let detail: String?
    public let evidence: [Evidence]
    public let revision: Int

    public init(
        id: String,
        text: String,
        detail: String? = nil,
        evidence: [Evidence],
        revision: Int
    ) {
        self.id = id
        self.text = text
        self.detail = detail
        self.evidence = evidence
        self.revision = revision
    }
}

public struct MeetingSummary: Codable, Equatable, Sendable {
    public let text: String
    public let decisions: [String]
    public let openQuestions: [String]
    public let owners: [String]
    public let nextSteps: [String]
    public let revision: Int
    public let createdAt: String

    public init(
        text: String,
        decisions: [String],
        openQuestions: [String],
        owners: [String],
        nextSteps: [String],
        revision: Int,
        createdAt: String
    ) {
        self.text = text
        self.decisions = decisions
        self.openQuestions = openQuestions
        self.owners = owners
        self.nextSteps = nextSteps
        self.revision = revision
        self.createdAt = createdAt
    }
}

public struct ProviderReceipt: Codable, Equatable, Sendable {
    public let id: String
    public let url: String?
    public let detail: String?

    public init(id: String, url: String? = nil, detail: String? = nil) {
        self.id = id
        self.url = url
        self.detail = detail
    }
}

public struct MeetingWarning: Codable, Equatable, Sendable {
    public let code: String
    public let message: String
    public let createdAt: String

    public init(code: String, message: String, createdAt: String) {
        self.code = code
        self.message = message
        self.createdAt = createdAt
    }
}

public enum FinalizationState: String, Codable, Equatable, Sendable {
    case notStarted = "not_started"
    case running
    case completed
    case failed
}

public struct Finalization: Codable, Equatable, Sendable {
    public let state: FinalizationState
    public let error: String?
    public let receipt: ProviderReceipt?

    public init(state: FinalizationState, error: String? = nil, receipt: ProviderReceipt? = nil) {
        self.state = state
        self.error = error
        self.receipt = receipt
    }
}

public enum ProviderMode: String, Codable, Equatable, Sendable {
    case live
    case fixture
    case unconfigured
}

public struct OperatorMessage: Codable, Equatable, Sendable {
    public let id: String
    public let text: String
    public let createdAt: String

    public init(id: String, text: String, createdAt: String) {
        self.id = id
        self.text = text
        self.createdAt = createdAt
    }
}

public enum MeetingTaskStatus: String, Codable, Equatable, Sendable {
    case queued
    case running
    case reviewRequired = "review_required"
    case completed
    case failed
    case cancelled
}

public typealias TaskStatus = MeetingTaskStatus

public struct MeetingTask: Codable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let status: MeetingTaskStatus
    public let content: String?
    public let url: String?
    public let error: String?
    public let generation: Int?
    public let artifactDigest: String?
    public let contextDigest: String?
    public let origin: TaskOrigin?

    public init(
        id: String,
        title: String,
        status: MeetingTaskStatus,
        content: String? = nil,
        url: String? = nil,
        error: String? = nil,
        generation: Int? = nil,
        artifactDigest: String? = nil,
        contextDigest: String? = nil,
        origin: TaskOrigin? = nil
    ) {
        self.id = id
        self.title = title
        self.status = status
        self.content = content
        self.url = url
        self.error = error
        self.generation = generation
        self.artifactDigest = artifactDigest
        self.contextDigest = contextDigest
        self.origin = origin
    }
}

public struct TaskOrigin: Codable, Equatable, Sendable {
    public let meetingId: String
    public let revision: Int
    public let contextRevision: Int?
    public let contextDigest: String?
    public let correctionEpoch: Int
    public let lastSegmentId: String?
    public let finalCount: Int
    public let capturedAt: Double

    public init(
        meetingId: String,
        revision: Int,
        contextRevision: Int? = nil,
        contextDigest: String? = nil,
        correctionEpoch: Int,
        lastSegmentId: String? = nil,
        finalCount: Int,
        capturedAt: Double
    ) {
        self.meetingId = meetingId
        self.revision = revision
        self.contextRevision = contextRevision
        self.contextDigest = contextDigest
        self.correctionEpoch = correctionEpoch
        self.lastSegmentId = lastSegmentId
        self.finalCount = finalCount
        self.capturedAt = capturedAt
    }
}

public enum CalendarActionStatus: String, Codable, Equatable, Sendable {
    case proposed
    case confirmed
    case sent
    case uncertain
    case failed
    case cancelled
}

public struct CalendarAttendee: Codable, Equatable, Sendable {
    public let email: String
    public let name: String?

    public init(email: String, name: String? = nil) {
        self.email = email
        self.name = name
    }
}

public struct CalendarAction: Codable, Equatable, Sendable {
    public let id: String
    public let proposalVersion: Int
    public let title: String
    public let start: String
    public let end: String
    public let timeZone: String
    public let attendees: [CalendarAttendee]
    public let description: String
    public let status: CalendarActionStatus
    public let providerError: String?

    public init(
        id: String,
        proposalVersion: Int,
        title: String,
        start: String,
        end: String,
        timeZone: String,
        attendees: [CalendarAttendee],
        description: String,
        status: CalendarActionStatus,
        providerError: String? = nil
    ) {
        self.id = id
        self.proposalVersion = proposalVersion
        self.title = title
        self.start = start
        self.end = end
        self.timeZone = timeZone
        self.attendees = attendees
        self.description = description
        self.status = status
        self.providerError = providerError
    }
}

public enum DeliveryActionStatus: String, Codable, Equatable, Sendable {
    case proposed
    case sending
    case sent
    case uncertain
    case failed
    case cancelled
}

public struct DeliveryRecipient: Codable, Equatable, Sendable {
    public let email: String
    public let name: String?

    public init(email: String, name: String? = nil) {
        self.email = email
        self.name = name
    }
}

public struct DocumentDeliveryAction: Codable, Equatable, Sendable {
    public let id: String
    public let proposalVersion: Int
    public let taskId: String
    public let generation: Int
    public let artifactDigest: String
    public let contextDigest: String
    public let recipient: DeliveryRecipient
    public let subject: String
    public let body: String
    public let filename: String
    public let contentType: String
    public let status: DeliveryActionStatus
    public let providerError: String?
    public let providerMessageId: String?

    public init(
        id: String,
        proposalVersion: Int,
        taskId: String,
        generation: Int,
        artifactDigest: String,
        contextDigest: String,
        recipient: DeliveryRecipient,
        subject: String,
        body: String,
        filename: String,
        contentType: String = "text/markdown; charset=utf-8",
        status: DeliveryActionStatus,
        providerError: String? = nil,
        providerMessageId: String? = nil
    ) {
        self.id = id
        self.proposalVersion = proposalVersion
        self.taskId = taskId
        self.generation = generation
        self.artifactDigest = artifactDigest
        self.contextDigest = contextDigest
        self.recipient = recipient
        self.subject = subject
        self.body = body
        self.filename = filename
        self.contentType = contentType
        self.status = status
        self.providerError = providerError
        self.providerMessageId = providerMessageId
    }
}

public struct MeetingSnapshot: Codable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let status: MeetingStatus
    public let revision: Int
    public let participants: [Participant]
    public let transcript: [TranscriptSegment]
    public let cue: Cue?
    public let summary: MeetingSummary?
    public let tasks: [MeetingTask]
    public let calendarAction: CalendarAction?
    public let deliveryAction: DocumentDeliveryAction?
    public let warnings: [MeetingWarning]?
    public let finalization: Finalization?
    public let providerMode: ProviderMode?
    public let operatorMessages: [OperatorMessage]?
    public let createdAt: String
    public let updatedAt: String

    public init(
        id: String,
        title: String,
        status: MeetingStatus,
        revision: Int,
        participants: [Participant],
        transcript: [TranscriptSegment],
        cue: Cue? = nil,
        summary: MeetingSummary? = nil,
        tasks: [MeetingTask],
        calendarAction: CalendarAction? = nil,
        deliveryAction: DocumentDeliveryAction? = nil,
        warnings: [MeetingWarning]? = nil,
        finalization: Finalization? = nil,
        providerMode: ProviderMode? = nil,
        operatorMessages: [OperatorMessage]? = nil,
        createdAt: String,
        updatedAt: String
    ) {
        self.id = id
        self.title = title
        self.status = status
        self.revision = revision
        self.participants = participants
        self.transcript = transcript
        self.cue = cue
        self.summary = summary
        self.tasks = tasks
        self.calendarAction = calendarAction
        self.deliveryAction = deliveryAction
        self.warnings = warnings
        self.finalization = finalization
        self.providerMode = providerMode
        self.operatorMessages = operatorMessages
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct CreateMeetingRequest: Codable, Equatable, Sendable {
    public let title: String
    public let participantNames: [String]?

    public init(title: String, participantNames: [String]? = nil) {
        self.title = title
        self.participantNames = participantNames
    }
}

public struct ConfirmActionRequest: Codable, Equatable, Sendable {
    public let proposalVersion: Int

    public init(proposalVersion: Int) {
        self.proposalVersion = proposalVersion
    }
}

public struct ReviewTaskRequest: Codable, Equatable, Sendable {
    public let generation: Int
    public let contextDigest: String

    public init(generation: Int, contextDigest: String) {
        self.generation = generation
        self.contextDigest = contextDigest
    }
}

public struct ProposeDeliveryRequest: Codable, Equatable, Sendable {
    public let recipient: String

    public init(recipient: String = "self") {
        self.recipient = recipient
    }
}

public struct ConfirmDeliveryRequest: Codable, Equatable, Sendable {
    public let proposalVersion: Int

    public init(proposalVersion: Int) {
        self.proposalVersion = proposalVersion
    }
}

public enum MeetingControlAction: String, Codable, Equatable, Sendable {
    case pause
    case resume
}

public struct MeetingControlRequest: Codable, Equatable, Sendable {
    public let action: MeetingControlAction

    public init(action: MeetingControlAction) {
        self.action = action
    }
}

public struct MeetingStatusPayload: Codable, Equatable, Sendable {
    public let status: MeetingStatus
    public let revision: Int

    public init(status: MeetingStatus, revision: Int) {
        self.status = status
        self.revision = revision
    }
}

public struct TaskEventPayload: Codable, Equatable, Sendable {
    public let task: MeetingTask

    public init(task: MeetingTask) {
        self.task = task
    }
}

public struct ActionEventPayload: Codable, Equatable, Sendable {
    public let calendarAction: CalendarAction

    public init(calendarAction: CalendarAction) {
        self.calendarAction = calendarAction
    }
}

public struct DeliveryEventPayload: Codable, Equatable, Sendable {
    public let deliveryAction: DocumentDeliveryAction

    public init(deliveryAction: DocumentDeliveryAction) {
        self.deliveryAction = deliveryAction
    }
}

public struct ErrorPayload: Codable, Equatable, Sendable {
    public let code: String
    public let message: String
    public let retryable: Bool?

    public init(code: String, message: String, retryable: Bool? = nil) {
        self.code = code
        self.message = message
        self.retryable = retryable
    }
}

public struct WebSocketAuthMessage: Codable, Equatable, Sendable {
    public let type: String
    public let token: String

    public init(token: String) {
        self.type = "auth"
        self.token = token
    }
}

public typealias WsAuthMessage = WebSocketAuthMessage

/// The payload enum intentionally contains only the fields used by the phone
/// companion. `MeetingEventEnvelope` below retains the event's meeting ID and
/// performs the cross-meeting check used by `MeetingAPI.events(id:)`.
public enum MeetingEvent: Decodable, Equatable, Sendable {
    case snapshot(MeetingSnapshot)
    case transcript(TranscriptSegment)
    case cue(Cue)
    case summary(MeetingSummary)
    case task(MeetingTask)
    case action(CalendarAction)
    case delivery(DocumentDeliveryAction)
    case status(String, Int)
    case error(String)

    private enum CodingKeys: String, CodingKey {
        case type
        case meetingId
        case payload
    }

    private enum EventType: String, Decodable {
        case snapshot
        case transcript
        case cue
        case summary
        case task
        case action
        case delivery
        case status
        case error
    }

    /// Decodes the complete wire event. The envelope's meeting ID is checked
    /// for presence and non-emptiness even though the compact enum cases do not
    /// carry it.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(EventType.self, forKey: .type)
        let meetingId = try container.decode(String.self, forKey: .meetingId)
        guard !meetingId.isEmpty else {
            throw DecodingError.dataCorruptedError(
                forKey: .meetingId,
                in: container,
                debugDescription: "meetingId must not be empty"
            )
        }
        let payload = try container.superDecoder(forKey: .payload)

        switch type {
        case .snapshot:
            self = .snapshot(try MeetingSnapshot(from: payload))
        case .transcript:
            self = .transcript(try TranscriptSegment(from: payload))
        case .cue:
            self = .cue(try Cue(from: payload))
        case .summary:
            self = .summary(try MeetingSummary(from: payload))
        case .task:
            self = .task(try TaskEventPayload(from: payload).task)
        case .action:
            self = .action(try ActionEventPayload(from: payload).calendarAction)
        case .delivery:
            self = .delivery(try DeliveryEventPayload(from: payload).deliveryAction)
        case .status:
            let status = try MeetingStatusPayload(from: payload)
            self = .status(status.status.rawValue, status.revision)
        case .error:
            self = .error(try ErrorPayload(from: payload).message)
        }
    }
}

/// The exact WebSocket wire representation. The public `event` is compact for
/// consumers, while `meetingId` remains available for routing/guard checks.
public struct MeetingEventEnvelope: Decodable, Equatable, Sendable {
    public let meetingId: String
    public let event: MeetingEvent

    private enum CodingKeys: String, CodingKey {
        case meetingId
    }

    public init(meetingId: String, event: MeetingEvent) {
        self.meetingId = meetingId
        self.event = event
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let meetingId = try container.decode(String.self, forKey: .meetingId)
        guard !meetingId.isEmpty else {
            throw DecodingError.dataCorruptedError(
                forKey: .meetingId,
                in: container,
                debugDescription: "meetingId must not be empty"
            )
        }
        self.meetingId = meetingId
        self.event = try MeetingEvent(from: decoder)
    }
}

/// Alias used by callers that mirror the TypeScript contract's name.
public typealias ServerEvent = MeetingEventEnvelope
