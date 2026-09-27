import Foundation
import Combine
#if !GLANCE_PHONE_ONLY
import MWDATCore
import MWDATSpeech
import MWDATDisplay
#endif

@MainActor
enum MetaSDKBootstrap {
    static let failure: String? = {
        #if !GLANCE_PHONE_ONLY
        do { try Wearables.configure(); return nil }
        catch { return error.localizedDescription }
        #else
        return "Phone-only build"
        #endif
    }()
    static var ready: Bool { failure == nil }
}

struct GlassesCard {
    var title: String
    var body: String
    var primaryLabel: String = "Details"
    var secondaryLabel: String = "Next"
    var primary: (() -> Void)?
    var secondary: (() -> Void)?
    var showsButtons = true
    var showsSecondary = true
    var identity: String?
    var isContextCard = false
    var captureLabel: String = "Pause"
    var captureAction: (() -> Void)?
    var sourceLabel: String = "Context"
}

/// One real DAT DeviceSession owns both Speech and Display. No simulated device is created.
@MainActor
final class MetaGlassesController: ObservableObject {
    @Published var registration = "Not connected" { didSet { NativeDiagnostics.record(["registration": registration]) } }
    @Published var status = "Connect Meta glasses"
    @Published var displayReady = false { didSet { NativeDiagnostics.record(["displayReady": String(displayReady)]) } }
    @Published var speechReady = false { didSet { NativeDiagnostics.record(["speechReady": String(speechReady)]) } }
    @Published var needsGlassesUpdate = false
    @Published var devices: [String] = []
    var onTranscript: ((String, Bool) -> Void)?
    var onError: ((String) -> Void)?
    var onInterrupted: (() -> Void)?
    var onListeningChanged: ((Bool) -> Void)?
    var onRegistered: (() -> Void)?
    private var pendingCard = GlassesCard(title: "kompX", body: "")
    private var generation = 0
    private var wantsSpeech = false
    private var captureIntentEpoch = 0
    private var isDisconnecting = false
    private var lastRenderedKey: String?
    private var quiet = false
    private var discoveryTask: Task<Void, Never>?
    private var availabilityTask: Task<Void, Never>?
    private var registrationTask: Task<Void, Never>?
    private var sendTask: Task<Void, Never>?
    private var timeoutTask: Task<Void, Never>?
    private var speechRestartTask: Task<Void, Never>?
    private var recentSpeechRestarts = 0
    private var lastSpeechStart = Date.distantPast
    #if !GLANCE_PHONE_ONLY
    private var selector: AutoDeviceSelector?
    private var sessionSelector: (any DeviceSelector)?
    private var knownDisplayIdentifiers: [DeviceIdentifier] = []
    private var session: DeviceSession?
    private var speech: Speech?
    private var display: Display?
    private var tokens: [any AnyListenerToken] = []
    private var deviceStateTokens: [any AnyListenerToken] = []
    private var stateTask: Task<Void, Never>?
    private var errorTask: Task<Void, Never>?
    #endif

    init() {
        #if !GLANCE_PHONE_ONLY
        NativeDiagnostics.record(["sdkReady": String(MetaSDKBootstrap.ready), "glassesTranscriptEventCount": "0", "glassesFinalNonemptyCount": "0", "displayReady": "false", "speechReady": "false"])
        guard MetaSDKBootstrap.ready else {
            registration = "SDK unavailable"
            status = "Meta SDK could not initialize: \(MetaSDKBootstrap.failure ?? "unknown error"). Phone fallback remains available."
            return
        }
        let selector = AutoDeviceSelector(wearables: Wearables.shared, filter: { $0.supportsDisplay() })
        self.selector = selector
        availabilityTask = Task { [weak self] in
            for await identifier in selector.activeDeviceStream() {
                guard !Task.isCancelled, let self else { return }
                NativeDiagnostics.record(["selectorHasDevice": String(identifier != nil)])
                if identifier != nil, Wearables.shared.registrationState == .registered { self.onRegistered?() }
            }
        }
        discoveryTask = Task { [weak self] in
            for await ids in Wearables.shared.devicesStream() {
                guard !Task.isCancelled else { return }
                if let self {
                    for token in self.deviceStateTokens { await token.cancel() }
                    self.deviceStateTokens.removeAll()
                    for id in ids {
                        guard let device = Wearables.shared.deviceForIdentifier(id), device.supportsDisplay() else { continue }
                        self.recordDeviceState(device)
                        self.deviceStateTokens.append(device.addDeviceStateListener { [weak self] _ in
                            Task { @MainActor in self?.recordDeviceState(device) }
                        })
                    }
                }
                self?.knownDisplayIdentifiers = ids.filter { Wearables.shared.deviceForIdentifier($0)?.supportsDisplay() == true }
                let summaries = ids.compactMap { id -> String? in
                    guard let device = Wearables.shared.deviceForIdentifier(id) else { return nil }
                    return "display=\(device.supportsDisplay()),link=\(device.linkState),compatibility=\(device.compatibility().displayString)"
                }
                NativeDiagnostics.record(["deviceCount": String(ids.count), "deviceCapabilities": summaries.joined(separator: ";")])
                self?.devices = ids.compactMap { id in
                    guard let device = Wearables.shared.deviceForIdentifier(id) else { return nil }
                    return "\(device.nameOrId()) · \(device.linkState) · \(device.compatibility().displayString)"
                }
            }
        }
        registrationTask = Task { [weak self] in
            for await state in Wearables.shared.registrationStateStream() {
                guard !Task.isCancelled else { return }
                self?.registration = state.description
                if state == .available || state == .unavailable { await self?.disconnect() }
                if state == .registered { self?.onRegistered?() }
            }
        }
        #else
        registration = "Phone-only build"
        status = "Meta SDK requires the full GlanceQM build. Phone fallback is available."
        #endif
    }

    func register() async {
        #if !GLANCE_PHONE_ONLY
        guard MetaSDKBootstrap.ready else { report(status); return }
        if Wearables.shared.registrationState == .registered { onRegistered?(); return }
        if Wearables.shared.registrationState == .registering { return }
        do { try await Wearables.shared.startRegistration() }
        catch { report(error.localizedDescription) }
        #endif
    }

    func handleURL(_ url: URL) async {
        #if !GLANCE_PHONE_ONLY
        guard MetaSDKBootstrap.ready else { return }
        guard URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains(where: { $0.name == "metaWearablesAction" }) == true else { return }
        do { _ = try await Wearables.shared.handleUrl(url) }
        catch { report(error.localizedDescription) }
        #endif
    }

    func updateGlasses() async {
        #if !GLANCE_PHONE_ONLY
        guard MetaSDKBootstrap.ready else { report(status); return }
        do { try await Wearables.shared.openDATGlassesAppUpdate() }
        catch { report(error.localizedDescription) }
        #endif
    }

    /// Invoked only by the wearer's Start/Connect control; permission may open Meta AI.
    func start(useGlassesSpeech: Bool) async throws {
        #if !GLANCE_PHONE_ONLY
        if useGlassesSpeech { captureIntentEpoch += 1 }
        let requestedCaptureEpoch = captureIntentEpoch
        guard MetaSDKBootstrap.ready else { throw GlanceError.message(status) }
        if isDisconnecting {
            for _ in 0..<40 {
                try await Task.sleep(for: .milliseconds(50))
                if !isDisconnecting { break }
            }
            guard !isDisconnecting else { throw GlanceError.message("The previous glasses session is closing. Try again.") }
        }
        if useGlassesSpeech, requestedCaptureEpoch != captureIntentEpoch { throw CancellationError() }
        guard Wearables.shared.registrationState == .registered else { throw GlanceError.message("Tap Register glasses first, then approve Glance QM in Meta AI.") }
        if useGlassesSpeech {
            var permission = try await Wearables.shared.checkPermissionStatus(.microphone)
            NativeDiagnostics.record(["glassesMicrophonePermission": permission == .granted ? "granted" : "not-granted"])
            if permission != .granted {
                NativeDiagnostics.record(["microphonePermissionRequestAt": ISO8601DateFormatter().string(from: Date())])
                permission = try await Wearables.shared.requestPermission(.microphone)
            }
            NativeDiagnostics.record(["glassesMicrophonePermission": permission == .granted ? "granted" : "not-granted"])
            guard permission == .granted else { throw GlanceError.message("Glasses microphone permission was not granted.") }
            guard requestedCaptureEpoch == captureIntentEpoch else { throw CancellationError() }
        }
        if let session {
            wantsSpeech = useGlassesSpeech
            if session.state == .started {
                try attachCapabilities(to: session, generation: generation)
                if !useGlassesSpeech { speech?.stop() }
            } else if session.state == .paused {
                throw GlanceError.message("The glasses session is paused by the system. Wait for it to resume.")
            } else if session.state == .stopped {
                await disconnect()
                throw GlanceError.message("The previous glasses session closed. Tap Start again.")
            } else if session.state == .stopping {
                throw GlanceError.message("The previous glasses session is closing. Try again.")
            }
            return
        }
        guard let selector else { throw GlanceError.message("Glasses discovery is unavailable.") }
        // Follow the official DisplayAccess session flow: a known paired
        // display may be selected before its link connects. The SDK's start()
        // owns connection/compatibility negotiation; do not gate it on a link
        // that may only become connected during that negotiation.
        if selector.activeDevice == nil && knownDisplayIdentifiers.isEmpty {
            for _ in 0..<8 {
                try await Task.sleep(for: .milliseconds(250))
                if selector.activeDevice != nil || !knownDisplayIdentifiers.isEmpty { break }
            }
        }
        try Task.checkCancellation()
        if useGlassesSpeech, requestedCaptureEpoch != captureIntentEpoch { throw CancellationError() }
        guard Wearables.shared.registrationState == .registered else { throw GlanceError.message("Connect with Meta AI before starting.") }
        if session != nil { throw GlanceError.message("Glasses connection changed. Tap Start again.") }
        let chosenSelector: any DeviceSelector
        if selector.activeDevice == nil, knownDisplayIdentifiers.count == 1 {
            chosenSelector = SpecificDeviceSelector(device: knownDisplayIdentifiers[0])
            NativeDiagnostics.record(["selectionMode": "known-paired-display"])
        } else {
            chosenSelector = selector
            NativeDiagnostics.record(["selectionMode": "automatic-display"])
        }
        sessionSelector = chosenSelector
        generation += 1
        let current = generation
        wantsSpeech = useGlassesSpeech
        status = "Connecting glasses…"
        let newSession: DeviceSession
        do { newSession = try Wearables.shared.createSession(deviceSelector: chosenSelector) }
        catch {
            NativeDiagnostics.record(["sessionCreateError": Self.sessionErrorCode(error)])
            throw error
        }
        session = newSession
        stateTask = Task { [weak self] in
            for await state in newSession.stateStream() {
                guard let self, self.generation == current, !Task.isCancelled else { return }
                NativeDiagnostics.record(["deviceSessionState": state.description])
                switch state {
                case .started:
                    self.timeoutTask?.cancel()
                    do { try self.attachCapabilities(to: newSession, generation: current) }
                    catch { self.report(error.localizedDescription); await self.disconnect(); self.onInterrupted?() }
                case .paused:
                    self.status = "Glasses paused by system"
                    self.speechReady = false
                    self.onListeningChanged?(false)
                case .stopped:
                    self.status = "Glasses disconnected — tap Start to reconnect"
                    await self.disconnect()
                    self.onInterrupted?()
                default: self.status = "Glasses \(state)"
                }
            }
        }
        errorTask = Task { [weak self] in
            for await error in newSession.errorStream() {
                guard let self, self.generation == current, !Task.isCancelled else { return }
                NativeDiagnostics.record(["sessionError": Self.sessionErrorCode(error)])
                if case .unexpectedError(let detail) = error {
                    // This is the SDK control/session error, never an audio or transcript payload.
                    NativeDiagnostics.record(["sessionErrorDetail": String(detail.prefix(400))])
                }
                if error == .datAppOnTheGlassesUpdateRequired { self.needsGlassesUpdate = true }
                self.report(error.localizedDescription)
            }
        }
        timeoutTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(20))
            guard !Task.isCancelled, let self, self.generation == current else { return }
            self.report("Glasses connection timed out. Check Meta AI and tap Start to retry.")
            await self.disconnect()
            self.onInterrupted?()
        }
        do { try newSession.start() }
        catch {
            NativeDiagnostics.record(["sessionStartError": Self.sessionErrorCode(error)])
            if error == .datAppOnTheGlassesUpdateRequired { needsGlassesUpdate = true }
            await disconnect()
            throw error
        }
        #else
        throw GlanceError.message("This is the phone fallback build. Choose Phone microphone, or install the full Meta SDK build.")
        #endif
    }

    #if !GLANCE_PHONE_ONLY
    private func recordDeviceState(_ device: Device) {
        NativeDiagnostics.record(["deviceDonState": String(describing: device.donState), "deviceHingeState": String(describing: device.hingeState), "deviceThermalState": String(describing: device.thermalLevel), "deviceLinkState": String(describing: device.linkState), "deviceCompatibility": device.compatibility().displayString, "deviceStateAt": ISO8601DateFormatter().string(from: Date())])
    }

    private static func sessionErrorCode(_ error: DeviceSessionError) -> String {
        switch error {
        case .noEligibleDevice: return "noEligibleDevice"
        case .sessionAlreadyStopped: return "sessionAlreadyStopped"
        case .sessionAlreadyExists: return "sessionAlreadyExists"
        case .sessionIdle: return "sessionIdle"
        case .capabilityAlreadyActive: return "capabilityAlreadyActive"
        case .capabilityNotFound: return "capabilityNotFound"
        case .unexpectedError: return "unexpectedError"
        case .thermalCritical: return "thermalCritical"
        case .thermalEmergency: return "thermalEmergency"
        case .peakPowerShutdown: return "peakPowerShutdown"
        case .batteryCritical: return "batteryCritical"
        case .datAppOnTheGlassesUpdateRequired: return "datAppOnTheGlassesUpdateRequired"
        case .dwaUnavailable: return "dwaUnavailable"
        case .insufficientSDKVersion: return "insufficientSDKVersion"
        case .dwaOutOfStuRange: return "dwaOutOfStuRange"
        @unknown default: return "unknownSessionError"
        }
    }

    private func attachCapabilities(to session: DeviceSession, generation current: Int) throws {
        if display == nil {
            let capability = try session.addDisplay()
            display = capability
            tokens.append(capability.statePublisher.listen { [weak self] state in
                Task { @MainActor in
                    guard let self, self.generation == current else { return }
                    self.displayReady = state == .started
                    if state == .started { self.status = "Display connected"; if self.quiet { self.clear() } else { self.render(self.pendingCard) } }
                }
            })
            capability.start()
        }
        if wantsSpeech && speech == nil {
            NativeDiagnostics.record(["speechAttachAttemptAt": ISO8601DateFormatter().string(from: Date())])
            guard let capability = try session.addSpeech() else { throw GlanceError.message("Speech is unavailable on these glasses. Enable the experimental Speech capability in Wearables Developer Center.") }
            speech = capability
            NativeDiagnostics.record(["speechAttached": "true"])
            tokens.append(capability.transcriptionPublisher.listen { [weak self] result in
                Task { @MainActor in
                    guard let self, self.generation == current, self.wantsSpeech else { return }
                    NativeDiagnostics.increment("glassesTranscriptEventCount")
                    NativeDiagnostics.record(["lastGlassesTranscriptAt": ISO8601DateFormatter().string(from: Date()), "lastGlassesTranscriptFinal": String(result.isFinal), "lastGlassesTranscriptCharacterCount": String(result.text.count)])
                    if !result.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        NativeDiagnostics.record(["actualInputSource": "meta_speech", "lastNonemptyGlassesTranscriptAt": ISO8601DateFormatter().string(from: Date())])
                        if result.isFinal { NativeDiagnostics.increment("glassesFinalNonemptyCount") }
                    }
                    self.recentSpeechRestarts = 0
                    self.onTranscript?(result.text, result.isFinal)
                }
            })
            tokens.append(capability.statePublisher.listen { [weak self] state in
                Task { @MainActor in
                    guard let self, self.generation == current else { return }
                    self.speechReady = state == .started
                    NativeDiagnostics.record(["speechState": state.description])
                    if state == .started { NativeDiagnostics.record(["lastSpeechStartedAt": ISO8601DateFormatter().string(from: Date())]) }
                    self.onListeningChanged?(self.speechReady)
                    self.status = "Glasses speech \(state)"
                    if state == .stopped { self.restartSpeechIfActive(generation: current) }
                }
            })
            tokens.append(capability.localePublisher.listen { [weak self] locale in
                Task { @MainActor in
                    guard let self, self.generation == current else { return }
                    self.status = "Glasses language: \(locale)"
                }
            })
            tokens.append(capability.errorPublisher.listen { [weak self] error in
                Task { @MainActor in
                    guard let self, self.generation == current else { return }
                    NativeDiagnostics.record(["speechError": error.description])
                    self.report("Glasses speech: \(error.localizedDescription)")
                    self.speechReady = false
                    self.wantsSpeech = false
                    self.speech?.stop()
                    self.onInterrupted?()
                }
            })
            lastSpeechStart = Date()
            NativeDiagnostics.record(["speechStartAttemptAt": ISO8601DateFormatter().string(from: Date())])
            capability.start()
        } else if wantsSpeech, let speech, speech.state != .started && speech.state != .starting { lastSpeechStart = Date(); speech.start() }
    }

    private func restartSpeechIfActive(generation current: Int) {
        guard wantsSpeech, session?.state == .started else { return }
        speechRestartTask?.cancel()
        speechRestartTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled, let self, self.generation == current,
                  self.wantsSpeech, self.session?.state == .started,
                  let speech = self.speech, speech.state == .stopped else { return }
            self.recentSpeechRestarts = Date().timeIntervalSince(self.lastSpeechStart) < 2 ? self.recentSpeechRestarts + 1 : 0
            guard self.recentSpeechRestarts <= 3 else {
                self.wantsSpeech = false
                self.report("Glasses recognition repeatedly stopped. Tap Start to retry after checking Meta AI.")
                self.onInterrupted?()
                return
            }
            self.lastSpeechStart = Date()
            speech.start()
        }
    }
    #endif

    func pauseSpeech() {
        captureIntentEpoch += 1
        speechRestartTask?.cancel(); speechRestartTask = nil
        wantsSpeech = false
        speechReady = false
        #if !GLANCE_PHONE_ONLY
        speech?.stop()
        #endif
    }

    func render(_ card: GlassesCard) {
        quiet = false
        pendingCard = card
        #if !GLANCE_PHONE_ONLY
        guard displayReady, let display else { return }
        let key = [card.title, card.body, card.primaryLabel, card.secondaryLabel, String(card.showsButtons), String(card.showsSecondary), card.identity ?? "", String(card.isContextCard), card.captureLabel, card.sourceLabel].joined(separator: "\u{1F}")
        guard key != lastRenderedKey else { return }
        lastRenderedKey = key
        let current = generation
        // Serial sends prevent an older slow card from overwriting the latest cue.
        let previous = sendTask
        sendTask = Task { [weak self] in
            await previous?.value
            guard !Task.isCancelled, let self, current == self.generation else { return }
            do {
                try await display.send(
                    FlexBox(direction: .column, spacing: 12, alignment: .start, crossAlignment: .center) {
                        Text("kompX", style: .heading).alignSelf(.center)
                        if card.isContextCard {
                            ButtonGroup(alignment: .center) {
                                Button(label: card.captureLabel, style: .primary, onClick: { [weak self] in
                                    Task { @MainActor in
                                        guard let self, self.generation == current, self.lastRenderedKey == key else { return }
                                        NativeDiagnostics.record(["lastLensTapAt": ISO8601DateFormatter().string(from: Date()), "lastLensButton": card.captureLabel])
                                        card.captureAction?()
                                    }
                                })
                            }
                        }
                        if card.showsButtons && !card.isContextCard { ButtonGroup(alignment: .center) {
                            Button(label: card.primaryLabel, style: .primary, onClick: { [weak self] in
                                Task { @MainActor in
                                    guard let self, self.generation == current, self.lastRenderedKey == key else { return }
                                    NativeDiagnostics.record(["lastLensTapAt": ISO8601DateFormatter().string(from: Date()), "lastLensButton": card.primaryLabel])
                                    card.primary?()
                                }
                            }).actionRole(.primary)
                            if card.showsSecondary { Button(label: card.secondaryLabel, style: .secondary, onClick: { [weak self] in
                                Task { @MainActor in
                                    guard let self, self.generation == current, self.lastRenderedKey == key else { return }
                                    NativeDiagnostics.record(["lastLensTapAt": ISO8601DateFormatter().string(from: Date()), "lastLensButton": card.secondaryLabel])
                                    card.secondary?()
                                }
                            }) }
                        } }
                        if card.isContextCard {
                            FlexBox(direction: .column, spacing: 8, alignment: .start, crossAlignment: .stretch) {
                                Text(ContextCardContent(text: card.body).heading ?? card.title, style: .body)
                                for row in ContextCardContent(text: card.body).rows {
                                    if !row.isEmpty { Text(row, style: .body) }
                                }
                                Text(card.sourceLabel, style: .meta, color: .secondary)
                                ButtonGroup(alignment: .center) {
                                    Button(label: card.primaryLabel, style: .secondary, onClick: { [weak self] in
                                        Task { @MainActor in
                                            guard let self, self.generation == current, self.lastRenderedKey == key else { return }
                                            NativeDiagnostics.record(["lastLensTapAt": ISO8601DateFormatter().string(from: Date()), "lastLensButton": card.primaryLabel])
                                            card.primary?()
                                        }
                                    }).actionRole(.primary)
                                }
                            }
                            .padding(12)
                            .background(.card)
                            .alignSelf(.stretch)
                        } else if card.title != "kompX" || !card.body.isEmpty {
                            FlexBox(direction: .column, spacing: 8, alignment: .start, crossAlignment: .stretch) {
                                if card.title != "kompX" { Text(card.title, style: .body, color: .secondary) }
                                if !card.body.isEmpty { Text(card.body, style: .body) }
                            }.alignSelf(.stretch)
                        }
                        // Consume remaining vertical space below content so the
                        // wordmark/controls stay at the top of the viewport.
                        FlexBox(direction: .column) { }.flexGrow(1)
                    }
                    .flexGrow(1)
                    .alignSelf(.stretch)
                    .padding(EdgeInsets(top: 2, bottom: 0, leading: 20, trailing: 20))
                )
                NativeDiagnostics.record(["lastDisplayOperation": "card", "lastDisplayTitle": card.title, "lastDisplayAt": ISO8601DateFormatter().string(from: Date())])
            } catch { self.lastRenderedKey = nil; NativeDiagnostics.record(["displayErrorCode": String((error as NSError).code)]); self.report("Display: \(error.localizedDescription)") }
        }
        #endif
    }

    /// Clears app content only; the active Speech capability and OS indicators remain.
    func clear() {
        quiet = true
        #if !GLANCE_PHONE_ONLY
        guard displayReady, let display, lastRenderedKey != "__quiet__" else { return }
        lastRenderedKey = "__quiet__"
        let current = generation
        let previous = sendTask
        sendTask = Task { [weak self] in
            await previous?.value
            guard !Task.isCancelled, let self, current == self.generation else { return }
            do { try await display.clearDisplay(); NativeDiagnostics.record(["lastDisplayOperation": "clear"]) }
            catch { self.lastRenderedKey = nil; self.report("Display: \(error.localizedDescription)") }
        }
        #endif
    }

    func disconnect() async {
        guard !isDisconnecting else { return }
        isDisconnecting = true
        defer { isDisconnecting = false }
        captureIntentEpoch += 1
        generation += 1
        wantsSpeech = false
        displayReady = false
        lastRenderedKey = nil
        speechReady = false
        timeoutTask?.cancel(); timeoutTask = nil
        speechRestartTask?.cancel(); speechRestartTask = nil
        sendTask?.cancel(); sendTask = nil
        #if !GLANCE_PHONE_ONLY
        stateTask?.cancel(); stateTask = nil
        errorTask?.cancel(); errorTask = nil
        speech?.stop()
        for token in tokens { await token.cancel() }
        tokens.removeAll()
        if speech != nil { try? session?.removeSpeech() }
        speech = nil
        display?.stop(); display = nil
        session?.stop(); session = nil
        sessionSelector = nil
        #endif
    }

    private func report(_ message: String) { status = message; NativeDiagnostics.record(["lastMetaErrorAt": ISO8601DateFormatter().string(from: Date())]); onError?(message) }
}

enum GlanceError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}
