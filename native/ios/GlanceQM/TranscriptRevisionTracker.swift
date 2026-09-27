import Foundation

/// Converts a speech SDK's partial/final callbacks into the revisioned
/// transcript contract. The SDK callback does not expose an utterance ID, so a
/// local ID is generated when the first partial for an utterance arrives.
///
/// A final callback closes the current utterance. A repeated identical final
/// callback is acknowledged as a duplicate and produces no submission. The
/// first partial after a final always begins a new utterance and therefore gets
/// a new stable ID.
public struct TranscriptRevisionTracker {
    public typealias IdentifierProvider = () -> String

    private let identifierProvider: IdentifierProvider
    private var activeSegmentID: String?
    private var activeRevision: Int = 0
    private var activeIsFinal = false
    private var lastFinalKey: FinalKey?

    private struct FinalKey: Equatable {
        let text: String
        let speaker: String?
    }

    public init(identifierProvider: @escaping IdentifierProvider = { UUID().uuidString }) {
        self.identifierProvider = identifierProvider
    }

    /// The ID of the currently open utterance, if one exists.
    public var currentSegmentID: String? { activeSegmentID }

    /// The revision that will be assigned to the next update for the active
    /// utterance. It starts at zero for each generated segment ID.
    public var currentRevision: Int? {
        guard activeSegmentID != nil else { return nil }
        return activeRevision
    }

    /// Records one SDK callback. Blank callbacks are ignored because the
    /// shared contract requires non-empty text.
    public mutating func submit(
        text: String,
        isFinal: Bool,
        speaker: String? = nil
    ) -> TranscriptSubmission? {
        let normalizedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedText.isEmpty else { return nil }

        let normalizedSpeaker = speaker?.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanSpeaker = normalizedSpeaker?.isEmpty == true ? nil : normalizedSpeaker
        let key = FinalKey(text: normalizedText, speaker: cleanSpeaker)

        if isFinal, activeIsFinal, lastFinalKey == key {
            // Some speech providers repeat their final callback. Keep the
            // already accepted final revision and avoid a duplicate request.
            return nil
        }

        if activeSegmentID == nil || activeIsFinal {
            activeSegmentID = makeIdentifier()
            activeRevision = 0
            activeIsFinal = false
        } else {
            activeRevision += 1
        }

        guard let segmentID = activeSegmentID else { return nil }
        let submission = TranscriptSubmission(
            segmentId: segmentID,
            text: normalizedText,
            isFinal: isFinal,
            revision: activeRevision,
            speaker: cleanSpeaker
        )

        if isFinal {
            activeIsFinal = true
            lastFinalKey = key
        } else {
            // A new partial after a final opened a new utterance. Clearing the
            // remembered final ensures a later equal final is not mistaken for
            // a duplicate of the previous utterance.
            lastFinalKey = nil
        }
        return submission
    }

    /// Alias used by capture controllers that call speech updates `ingest`.
    public mutating func ingest(
        text: String,
        isFinal: Bool,
        speaker: String? = nil
    ) -> TranscriptSubmission? {
        submit(text: text, isFinal: isFinal, speaker: speaker)
    }

    /// Alias for capture adapters that expose callbacks as `accept`.
    public mutating func accept(
        text: String,
        isFinal: Bool,
        speaker: String? = nil
    ) -> TranscriptSubmission? {
        submit(text: text, isFinal: isFinal, speaker: speaker)
    }

    /// Alias used by capture controllers that call speech updates `update`.
    public mutating func update(
        text: String,
        isFinal: Bool,
        speaker: String? = nil
    ) -> TranscriptSubmission? {
        submit(text: text, isFinal: isFinal, speaker: speaker)
    }

    public mutating func reset() {
        activeSegmentID = nil
        activeRevision = 0
        activeIsFinal = false
        lastFinalKey = nil
    }

    private func makeIdentifier() -> String {
        let candidate = identifierProvider()
        return candidate.isEmpty ? UUID().uuidString : candidate
    }
}
