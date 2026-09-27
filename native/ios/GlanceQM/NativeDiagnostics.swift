import Foundation

/// Latest operational state only. Never stores token, audio, transcript text,
/// attendee details, device names, or cue bodies. Read via the app's supported
/// development data container during a paired-device rehearsal.
@MainActor
enum NativeDiagnostics {
    private static var state: [String: String] = [:]
    private static var sceneEvents: [String] = []
    static func recordScene(_ phase: String) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        sceneEvents.append(stamp + ":" + phase)
        sceneEvents = Array(sceneEvents.suffix(8))
        record(["appScenePhase": phase, "appScenePhaseAt": stamp, "sceneHistory": sceneEvents.joined(separator: " | "), "lastScene_" + phase: stamp])
    }
    static func increment(_ key: String) {
        let value = (Int(state[key] ?? "0") ?? 0) + 1
        record([key: String(value)])
    }
    static func record(_ fields: [String: String]) {
        #if os(iOS)
        state.merge(fields, uniquingKeysWith: { _, new in new })
        state["updatedAt"] = ISO8601DateFormatter().string(from: Date())
        guard let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return }
        let directory = root.appendingPathComponent("GlanceQM", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let data = try JSONSerialization.data(withJSONObject: state, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: directory.appendingPathComponent("diagnostics.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch { /* Diagnostics must never prevent a meeting. */ }
        #endif
    }
}
