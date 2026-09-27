import AVFoundation
import Foundation
import Speech

/// Errors raised while starting the phone microphone speech fallback.
enum PhoneSpeechCaptureError: LocalizedError {
    case speechPermissionDenied
    case speechPermissionRestricted
    case microphonePermissionDenied
    case speechUnavailable
    case phoneMicrophoneUnavailable
    case audioInputUnavailable
    case speechRecognition(String)
    case audioSession(String)
    case audioEngine(String)

    var errorDescription: String? {
        switch self {
        case .speechPermissionDenied:
            return "Speech Recognition permission is off. Enable it in Settings to use the phone microphone."
        case .speechPermissionRestricted:
            return "Speech Recognition is restricted on this device."
        case .microphonePermissionDenied:
            return "Microphone permission is off. Enable it in Settings to use the phone microphone."
        case .speechUnavailable:
            return "Apple Speech Recognition is temporarily unavailable."
        case .phoneMicrophoneUnavailable:
            return "The built-in phone microphone is unavailable."
        case .audioInputUnavailable:
            return "The phone microphone did not provide an audio input format."
        case let .speechRecognition(message):
            return "Apple Speech Recognition stopped: \(message)"
        case let .audioSession(message):
            return "The phone microphone audio session could not start: \(message)"
        case let .audioEngine(message):
            return "The phone microphone audio engine could not start: \(message)"
        }
    }
}

/// Continuous speech capture from the iPhone's built-in microphone.
///
/// Apple speech recognition tasks have a roughly one-minute limit. This class
/// rotates requests at that boundary and also rotates when Apple returns a
/// final result. Segment callbacks are generation-guarded so a cancelled task
/// can never deliver stale text after a restart or stop.
@MainActor
final class PhoneSpeechCapture {
    typealias TranscriptHandler = (String, Bool) -> Void
    typealias ErrorHandler = (String) -> Void
    typealias StatusHandler = (String) -> Void

    var onTranscript: TranscriptHandler?
    var onError: ErrorHandler?
    var onStatus: StatusHandler?

    /// The selected physical input. It is always the built-in phone mic after
    /// a successful `start()`, never a Bluetooth/glasses route.
    private(set) var actualInputName: String = "Phone microphone"

    private static let segmentDurationNanoseconds: UInt64 = 60 * 1_000_000_000
    private static let routeCheckDelayNanoseconds: UInt64 = 250_000_000

    private let audioEngine = AVAudioEngine()
    private let requestBox = PhoneAudioRequestBox()
    private let recognizer: SFSpeechRecognizer?
    private let audioSession = AVAudioSession.sharedInstance()
    private let notificationCenter = NotificationCenter.default

    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var tapInstalled = false
    private var rotationTask: Task<Void, Never>?
    private var routeCheckTask: Task<Void, Never>?
    private var interruptionObserver: NSObjectProtocol?
    private var routeChangeObserver: NSObjectProtocol?

    private var sessionGeneration: UInt = 0
    private var segmentGeneration: UInt = 0
    private var isStarting = false
    private(set) var isRunning = false
    private var interrupted = false
    private var lastTranscript = ""

    init(
        locale: Locale = .current,
        onTranscript: TranscriptHandler? = nil,
        onError: ErrorHandler? = nil,
        onStatus: StatusHandler? = nil
    ) {
        // The user's locale is preferred. English is a useful fallback for a
        // device whose current locale is not supported by Speech.
        self.recognizer = SFSpeechRecognizer(locale: locale)
            ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
        self.onTranscript = onTranscript
        self.onError = onError
        self.onStatus = onStatus
        installNotificationObservers()
    }

    deinit {
        if let interruptionObserver {
            notificationCenter.removeObserver(interruptionObserver)
        }
        if let routeChangeObserver {
            notificationCenter.removeObserver(routeChangeObserver)
        }
    }

    /// Requests both permissions, selects the built-in phone mic, and starts
    /// feeding live microphone buffers to Apple's Speech framework.
    func start() async throws {
        stop()

        sessionGeneration &+= 1
        let session = sessionGeneration
        isStarting = true
        onStatus?("Requesting microphone and Speech Recognition permission…")

        do {
            let speechAuthorization = await requestSpeechAuthorization()
            guard isCurrentSession(session) else { return }
            switch speechAuthorization {
            case .authorized:
                break
            case .denied:
                throw PhoneSpeechCaptureError.speechPermissionDenied
            case .restricted:
                throw PhoneSpeechCaptureError.speechPermissionRestricted
            case .notDetermined:
                // requestSpeechAuthorization only returns .notDetermined if
                // the authorization request was interrupted unexpectedly.
                throw PhoneSpeechCaptureError.speechPermissionDenied
            @unknown default:
                throw PhoneSpeechCaptureError.speechPermissionDenied
            }

            let microphoneAuthorized = await requestMicrophoneAuthorization()
            guard isCurrentSession(session) else { return }
            guard microphoneAuthorized else {
                throw PhoneSpeechCaptureError.microphonePermissionDenied
            }

            guard let recognizer, recognizer.isAvailable else {
                throw PhoneSpeechCaptureError.speechUnavailable
            }

            try configurePhoneMicrophone()
            guard isCurrentSession(session) else { return }

            isRunning = true
            try startRecognitionSegment(session: session, status: true)
            isStarting = false
        } catch is CancellationError {
            if isCurrentSession(session) {
                isStarting = false
                tearDownCapture(deactivateSession: true)
            }
            throw CancellationError()
        } catch {
            guard isCurrentSession(session) else { return }
            let captureError = asCaptureError(error)
            isStarting = false
            tearDownCapture(deactivateSession: true)
            reportError(captureError)
            throw captureError
        }
    }

    /// Cancels recognition, removes the audio tap, stops the engine, cancels
    /// pending timers/tasks, and deactivates the shared audio session.
    func stop() {
        let wasActive = isStarting || isRunning || recognitionTask != nil || tapInstalled

        sessionGeneration &+= 1
        isStarting = false
        isRunning = false
        interrupted = false
        routeCheckTask?.cancel()
        routeCheckTask = nil
        tearDownCapture(deactivateSession: true)

        if wasActive {
            onStatus?("Phone microphone stopped.")
        }
    }

    // MARK: - Permissions

    private func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        let current = SFSpeechRecognizer.authorizationStatus()
        guard current == .notDetermined else { return current }

        return await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }

    private func requestMicrophoneAuthorization() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            return true
        case .denied:
            return false
        case .undetermined:
            return await AVAudioApplication.requestRecordPermission()
        @unknown default:
            return false
        }
    }

    // MARK: - Audio setup

    private func configurePhoneMicrophone() throws {
        do {
            // Deliberately omit Bluetooth options. Even if glasses or another
            // accessory is connected, the only accepted input is builtInMic.
            try audioSession.setCategory(.record, mode: .measurement, options: [])
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

            guard let builtInInput = audioSession.availableInputs?.first(where: {
                $0.portType == .builtInMic
            }) else {
                throw PhoneSpeechCaptureError.phoneMicrophoneUnavailable
            }

            // This explicit preference is the important routing guarantee.
            // Do not fall back to currentRoute.inputs.first, which may be a
            // Bluetooth glasses microphone.
            try audioSession.setPreferredInput(builtInInput)
            actualInputName = builtInInput.portName.isEmpty
                ? "Phone microphone"
                : builtInInput.portName
            onStatus?("Phone microphone selected: \(actualInputName).")
        } catch let error as PhoneSpeechCaptureError {
            throw error
        } catch {
            throw PhoneSpeechCaptureError.audioSession(error.localizedDescription)
        }
    }

    private func installAudioTapIfNeeded() throws {
        guard !tapInstalled else { return }

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw PhoneSpeechCaptureError.audioInputUnavailable
        }

        inputNode.installTap(onBus: 0, bufferSize: 1_024, format: format) {
            [requestBox] buffer, _ in
            requestBox.append(buffer)
        }
        tapInstalled = true
    }

    private func startRecognitionSegment(session: UInt, status: Bool) throws {
        guard isCurrentSession(session), isRunning else { return }
        guard let recognizer, recognizer.isAvailable else {
            throw PhoneSpeechCaptureError.speechUnavailable
        }

        // Invalidate all callbacks from the previous segment before cancelling
        // it. SFSpeechRecognitionTask may call its handler during cancellation.
        segmentGeneration &+= 1
        let segment = segmentGeneration
        rotationTask?.cancel()
        rotationTask = nil
        cancelRecognitionOnly()

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        request.addsPunctuation = true
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        lastTranscript = ""
        recognitionRequest = request
        requestBox.set(request)

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            // Speech callbacks are not guaranteed to arrive on the main queue.
            // Hop back to the actor and retain both generations as a stale-task
            // guard across final-result and timer-driven restarts.
            Task { @MainActor [weak self] in
                self?.handleRecognition(
                    result: result,
                    error: error,
                    session: session,
                    segment: segment
                )
            }
        }

        try installAudioTapIfNeeded()
        if !audioEngine.isRunning {
            audioEngine.prepare()
            do {
                try audioEngine.start()
            } catch {
                throw PhoneSpeechCaptureError.audioEngine(error.localizedDescription)
            }
        }

        if status {
            if request.requiresOnDeviceRecognition {
                onStatus?("Using on-device Apple Speech Recognition on \(actualInputName).")
            } else {
                onStatus?("Using Apple Speech Recognition over the network on \(actualInputName).")
            }
            onStatus?("Listening on \(actualInputName).")
        }
        scheduleRotation(session: session, segment: segment)
    }

    private func scheduleRotation(session: UInt, segment: UInt) {
        rotationTask?.cancel()
        rotationTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(nanoseconds: PhoneSpeechCapture.segmentDurationNanoseconds)
            } catch {
                return
            }

            guard let self,
                  self.isCurrentSession(session),
                  self.segmentGeneration == segment,
                  self.isRunning,
                  !self.interrupted else { return }
            self.onStatus?("Refreshing Apple Speech Recognition after 60 seconds…")
            self.finishCurrentSegmentAndRestart(session: session, emitFinal: true)
        }
    }

    private func handleRecognition(
        result: SFSpeechRecognitionResult?,
        error: Error?,
        session: UInt,
        segment: UInt
    ) {
        guard isCurrentSession(session), isRunning,
              segmentGeneration == segment, !interrupted else { return }

        var receivedFinalResult = false
        if let result {
            let text = result.bestTranscription.formattedString
            receivedFinalResult = result.isFinal
            // Avoid duplicate partial callbacks, but always deliver a final
            // callback even when its text matches the last partial result.
            if text != lastTranscript || result.isFinal {
                lastTranscript = text
                onTranscript?(text, result.isFinal)
            }
        }

        if receivedFinalResult {
            finishCurrentSegmentAndRestart(session: session, emitFinal: false)
            return
        }

        if let error {
            // Cancellation errors from a rotation/stop are stale by the time
            // they reach here. A live task error is actionable for the caller.
            let message = error.localizedDescription.isEmpty
                ? "Apple Speech Recognition stopped unexpectedly."
                : error.localizedDescription
            reportError(.speechRecognition(message))
            stop()
        }
    }

    private func finishCurrentSegmentAndRestart(session: UInt, emitFinal: Bool) {
        guard isCurrentSession(session), isRunning else { return }

        if emitFinal {
            let text = lastTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                onTranscript?(text, true)
            }
        }

        do {
            try startRecognitionSegment(session: session, status: false)
        } catch {
            let captureError = asCaptureError(error)
            reportError(captureError)
            stop()
        }
    }

    private func cancelRecognitionOnly() {
        requestBox.clear()
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionRequest = nil
        recognitionTask = nil
    }

    private func tearDownCapture(deactivateSession: Bool) {
        rotationTask?.cancel()
        rotationTask = nil
        segmentGeneration &+= 1
        cancelRecognitionOnly()

        if audioEngine.isRunning {
            audioEngine.stop()
        }
        if tapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        audioEngine.reset()

        if deactivateSession {
            try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    // MARK: - Session notifications

    private func installNotificationObservers() {
        interruptionObserver = notificationCenter.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: audioSession,
            queue: .main
        ) { [weak self] notification in
            Task { @MainActor [weak self] in
                self?.handleInterruption(notification)
            }
        }

        routeChangeObserver = notificationCenter.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: audioSession,
            queue: .main
        ) { [weak self] notification in
            Task { @MainActor [weak self] in
                self?.handleRouteChange(notification)
            }
        }
    }

    private func handleInterruption(_ notification: Notification) {
        guard isRunning || isStarting else { return }
        guard let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: rawType) else {
            return
        }

        switch type {
        case .began:
            interrupted = true
            onStatus?("Phone microphone interrupted; waiting to resume…")
            // Keep the public session alive, but tear down the old graph and
            // task. The ended notification creates one fresh segment.
            tearDownCapture(deactivateSession: false)
        case .ended:
            guard interrupted else { return }
            interrupted = false
            let rawOptions = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let options = AVAudioSession.InterruptionOptions(rawValue: rawOptions)
            guard options.contains(.shouldResume) else {
                reportError(.audioSession("The microphone interruption did not permit recording to resume."))
                stop()
                return
            }

            let session = sessionGeneration
            onStatus?("Resuming phone microphone…")
            do {
                try configurePhoneMicrophone()
                try startRecognitionSegment(session: session, status: false)
                onStatus?("Listening on \(actualInputName).")
            } catch {
                let captureError = asCaptureError(error)
                reportError(captureError)
                stop()
            }
        @unknown default:
            break
        }
    }

    private func handleRouteChange(_ notification: Notification) {
        guard isRunning, !interrupted else { return }

        // Route notifications can arrive before Core Audio has finished
        // settling. Verify shortly afterwards and restore builtInMic only if a
        // non-phone route remains selected.
        guard let currentInput = audioSession.currentRoute.inputs.first else { return }
        guard currentInput.portType == .builtInMic else {
            routeCheckTask?.cancel()
            routeCheckTask = Task { @MainActor [weak self] in
                do {
                    try await Task.sleep(nanoseconds: PhoneSpeechCapture.routeCheckDelayNanoseconds)
                } catch {
                    return
                }
                self?.restoreBuiltInRouteIfNeeded()
            }
            return
        }
        if !currentInput.portName.isEmpty {
            actualInputName = currentInput.portName
        } else {
            actualInputName = "Phone microphone"
        }
    }

    private func restoreBuiltInRouteIfNeeded() {
        routeCheckTask = nil
        guard isRunning, !interrupted else { return }
        guard let currentInput = audioSession.currentRoute.inputs.first else { return }
        guard currentInput.portType != .builtInMic else {
            if !currentInput.portName.isEmpty {
                actualInputName = currentInput.portName
            }
            return
        }

        do {
            guard let builtInInput = audioSession.availableInputs?.first(where: {
                $0.portType == .builtInMic
            }) else {
                throw PhoneSpeechCaptureError.phoneMicrophoneUnavailable
            }
            try audioSession.setPreferredInput(builtInInput)
            guard audioSession.currentRoute.inputs.first?.portType == .builtInMic else {
                throw PhoneSpeechCaptureError.phoneMicrophoneUnavailable
            }
            actualInputName = builtInInput.portName.isEmpty
                ? "Phone microphone"
                : builtInInput.portName
            onStatus?("Phone microphone route restored: \(actualInputName).")
        } catch {
            let captureError = asCaptureError(error)
            reportError(captureError)
            stop()
        }
    }

    // MARK: - State/error helpers

    private func isCurrentSession(_ session: UInt) -> Bool {
        session == sessionGeneration
    }

    private func asCaptureError(_ error: Error) -> PhoneSpeechCaptureError {
        if let error = error as? PhoneSpeechCaptureError {
            return error
        }
        return .audioSession(error.localizedDescription)
    }

    private func reportError(_ error: PhoneSpeechCaptureError) {
        onError?(error.localizedDescription)
    }
}

/// A small lock-protected handoff from AVAudioEngine's realtime tap callback
/// to the current actor-owned recognition request. The tap stays installed
/// while a segment rotates, so there is no second tap and no duplicate audio
/// stream. The request is swapped only on the main actor.
private final class PhoneAudioRequestBox: @unchecked Sendable {
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?

    func set(_ request: SFSpeechAudioBufferRecognitionRequest) {
        lock.lock()
        self.request = request
        lock.unlock()
    }

    func clear() {
        lock.lock()
        request = nil
        lock.unlock()
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        let request = self.request
        lock.unlock()
        request?.append(buffer)
    }
}
