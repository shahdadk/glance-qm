import Foundation
import Combine
import UIKit

enum InputRoute: String { case glasses, phone }
enum GlassesFocus: CaseIterable { case listening, cue, details, summary, tasks, action, delivery, controls }

@MainActor
final class MeetingViewModel: ObservableObject {
    @Published var backendURL = UserDefaults.standard.string(forKey: "backend-url") ?? "http://localhost:8790"
    @Published var token = KeychainStore.readToken()
    @Published var title = "Meeting"
    @Published var participantNames = ""
    @Published var joinID = ""
    @Published var inputRoute: InputRoute = .glasses
    @Published var meeting: MeetingSnapshot?
    @Published var busy = false
    @Published var isCapturing = false {
        didSet {
            UIApplication.shared.isIdleTimerDisabled = isCapturing
            NativeDiagnostics.record(["captureIntent": String(isCapturing), "idleTimerDisabled": String(UIApplication.shared.isIdleTimerDisabled)])
        }
    }
    @Published var hasHeardSpeech = false
    @Published var recognizedFinalCount = 0
    @Published var diagnosticKeepDisplayActive = (UserDefaults.standard.object(forKey: "diagnostic-keep-display") as? Bool) ?? true {
        didSet { UserDefaults.standard.set(diagnosticKeepDisplayActive, forKey: "diagnostic-keep-display"); updateDisplay() }
    }
    @Published var captureStatus = "Ready to listen"
    @Published var connectionStatus = "Service not connected"
    @Published var errorMessage: String?
    @Published var partialTranscript = ""
    @Published var pendingUploadCount = 0
    @Published var displayTitle = "Ready when you are"
    @Published var displayBody = "Create or join a meeting. Then tap Start."
    @Published var displayPrimaryLabel = "Details"
    @Published var displaySecondaryLabel = "Next"
    let glasses = MetaGlassesController()
    private let phone = PhoneSpeechCapture()
    private var api: MeetingAPI?
    private var tracker = TranscriptRevisionTracker()
    private var queue: [TranscriptSubmission] = []
    private var uploadTask: Task<Void, Never>?
    private var eventTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private var revisionGeneration = 0
    private var focus = GlassesFocus.listening
    private var startOperationActive = false
    private var listeningAcknowledged = false
    private var startFailureMessage: String?
    private var loadingText = "Connecting…"
    private var displayReconnectAttempts = 0
    private var pager = DisplayPagination(text: "")
    private var pagerKey = ""
    private var displayedAction: CalendarAction?
    private var displayedDelivery: DocumentDeliveryAction?
    private var displayedTask: MeetingTask?
    private var selectedTaskID: String?
    private var reviewedDocumentIdentity: (taskId: String, generation: Int, artifactDigest: String, contextDigest: String)?
    private var primary: (() -> Void)?
    private var secondary: (() -> Void)?
    private var transientTask: Task<Void, Never>?
    private var transientNotice: (title: String, body: String, focus: GlassesFocus)?
    private var pendingFollowUpNotice: (title: String, body: String, focus: GlassesFocus)?
    private var showingPreloadedBrief = false

    var microphoneActive: Bool { inputRoute == .glasses ? glasses.speechReady : phone.isRunning }

    var inputDescription: String {
        inputRoute == .glasses ? "Input: Meta glasses microphone" : "Input: iPhone microphone fallback · \(phone.actualInputName)"
    }

    init() {
        if let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
            let pairing = documents.appendingPathComponent("pairing.json")
            if FileManager.default.fileExists(atPath: pairing.path) {
                do { try importPairing(pairing); try FileManager.default.removeItem(at: pairing) }
                catch { errorMessage = "Could not import local connection settings: \(error.localizedDescription)" }
            }
        }
        NativeDiagnostics.record(["configuredBackendHost": URL(string: backendURL)?.host ?? "invalid", "hasServiceToken": String(!token.isEmpty), "diagnosticKeepDisplayActive": String(diagnosticKeepDisplayActive), "acceptedTranscriptUpdateCount": "0", "acceptedFinalTranscriptCount": "0", "transcriptUploadCount": "0", "startTapCount": "0"])
        glasses.onRegistered = { [weak self] in
            Task { @MainActor in
                guard let self, !self.isCapturing else { return }
                await self.connectDisplay()
            }
        }
        glasses.onTranscript = { [weak self] text, final in self?.receiveTranscript(text, isFinal: final) }
        glasses.onListeningChanged = { [weak self] listening in
            guard let self, self.inputRoute == .glasses else { return }
            self.captureStatus = listening ? "Listening · glasses microphone" : "Glasses microphone inactive"
            if listening, self.isCapturing, !self.listeningAcknowledged {
                self.listeningAcknowledged = true
                self.transientNotice = ("kompX", "Listening", .listening)
                self.expireTransient(after: 1)
            }
            self.updateDisplay()
        }
        glasses.onError = { [weak self] error in self?.errorMessage = error }
        glasses.onInterrupted = { [weak self] in
            guard let self, self.inputRoute == .glasses else { return }
            if self.startOperationActive, !self.isCapturing, self.displayReconnectAttempts == 0 {
                self.displayReconnectAttempts += 1
                Task { await self.connectDisplay() }
                return
            }
            self.stopCapture()
            self.captureStatus = "Glasses stopped"
            self.showStartError(GlanceError.message(self.errorMessage ?? "Glasses disconnected. Reopen the glasses and tap Retry."))
        }
        phone.onTranscript = { [weak self] text, final in self?.receiveTranscript(text, isFinal: final) }
        phone.onError = { [weak self] error in
            self?.errorMessage = error
            self?.stopCapture()
            self?.captureStatus = "Phone microphone stopped"
        }
        if !token.isEmpty, let saved = UserDefaults.standard.string(forKey: "active-meeting-id") {
            Task { [weak self] in
                guard let self else { return }
                do {
                    let client = try self.makeAPI()
                    let snapshot = try await client.snapshot(id: saved)
                    guard self.meeting == nil, !self.busy, self.revisionGeneration == 0 else { return }
                    self.attach(snapshot, api: client)
                } catch { if self.meeting == nil { self.connectionStatus = "Tap Start to begin a meeting" } }
            }
        }
        phone.onStatus = { [weak self] status in
            guard let self, self.inputRoute == .phone else { return }
            self.captureStatus = status
            self.updateDisplay()
        }
    }

    func importPairing(_ url: URL) throws {
        struct Pairing: Decodable { let serverURL: String; let operatorToken: String; let keepDisplayActiveForDiagnostics: Bool? }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let data = try Data(contentsOf: url)
        guard data.count <= 16_384 else { throw GlanceError.message("Connection file is too large.") }
        let configuration = try JSONDecoder().decode(Pairing.self, from: data)
        _ = try MeetingAPI(baseURLString: configuration.serverURL, token: configuration.operatorToken)
        try KeychainStore.saveToken(configuration.operatorToken)
        backendURL = configuration.serverURL
        if let keepVisible = configuration.keepDisplayActiveForDiagnostics { diagnosticKeepDisplayActive = keepVisible }
        token = configuration.operatorToken
        UserDefaults.standard.set(backendURL, forKey: "backend-url")
        connectionStatus = "Connection settings imported securely"
    }

    func saveConfiguration() {
        do {
            _ = try makeAPI()
            try KeychainStore.saveToken(token.trimmingCharacters(in: .whitespacesAndNewlines))
            UserDefaults.standard.set(backendURL, forKey: "backend-url")
            connectionStatus = "Connection settings saved"
        } catch { errorMessage = error.localizedDescription }
    }

    private func makeAPI() throws -> MeetingAPI {
        guard let url = URL(string: backendURL.trimmingCharacters(in: .whitespacesAndNewlines)) else { throw GlanceError.message("Enter a valid service URL.") }
        return try MeetingAPI(baseURL: url, token: token.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    func createMeeting() async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        do {
            let client = try makeAPI()
            let names = participantNames.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
            NativeDiagnostics.record(["createMeetingAttemptAt": ISO8601DateFormatter().string(from: Date())])
            let snapshot = try await client.createMeeting(title: title, participantNames: names.isEmpty ? nil : names)
            NativeDiagnostics.record(["createMeetingSucceededAt": ISO8601DateFormatter().string(from: Date())])
            try KeychainStore.saveToken(token)
            UserDefaults.standard.set(backendURL, forKey: "backend-url")
            attach(snapshot, api: client)
            // Creating a shared meeting never starts a microphone.
        } catch { showStartError(error) }
    }

    func joinMeeting() async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        do {
            let client = try makeAPI()
            let snapshot = try await client.snapshot(id: joinID.trimmingCharacters(in: .whitespacesAndNewlines))
            attach(snapshot, api: client)
        } catch { errorMessage = error.localizedDescription }
    }

    private func attach(_ snapshot: MeetingSnapshot, api client: MeetingAPI) {
        eventTask?.cancel(); refreshTask?.cancel()
        revisionGeneration += 1
        api = client
        tracker = TranscriptRevisionTracker()
        meeting = snapshot
        NativeDiagnostics.record(["meetingAttached": "true", "meetingStatus": snapshot.status.rawValue])
        UserDefaults.standard.set(snapshot.id, forKey: "active-meeting-id")
        queue = []; pendingUploadCount = 0
        partialTranscript = ""
        errorMessage = nil
        focus = snapshot.status == .ended ? .summary : .listening
        pagerKey = ""
        updateDisplay()
        observeEvents(client: client, id: snapshot.id, generation: revisionGeneration)
    }

    func connectDisplay() async {
        guard !isCapturing else { return }
        do { try await glasses.start(useGlassesSpeech: false); updateDisplay() }
        catch {
            errorMessage = error.localizedDescription
            NativeDiagnostics.record(["displayConnectError": (error as? GlanceError)?.localizedDescription ?? "SDK session error"])
        }
    }

    func startListening(source: String = "phone") async {
        NativeDiagnostics.increment("startTapCount")
        NativeDiagnostics.record(["startTapAt": ISO8601DateFormatter().string(from: Date()), "startTapSource": source])
        guard !busy, !startOperationActive, !isCapturing else {
            NativeDiagnostics.record(["startRejectedReason": isCapturing ? "capture-already-requested" : "start-in-progress"])
            return
        }
        startOperationActive = true
        startFailureMessage = nil
        displayReconnectAttempts = 0
        loadingText = "Connecting…"
        defer { startOperationActive = false }
        NativeDiagnostics.record(["startRejectedReason": "", "startStage": "connecting-service"])
        glasses.render(GlassesCard(title: "kompX", body: loadingText, showsButtons: false))
        if meeting?.status == .ended { leaveMeeting() }
        if meeting == nil { await createMeeting() }
        guard meeting != nil else { return }
        await start()
    }

    func joinFromLink(_ id: String) async {
        guard !isCapturing, !busy, queue.isEmpty else {
            errorMessage = "Pause the current meeting before joining another."
            return
        }
        joinID = id
        await joinMeeting()
    }

    func start() async {
        guard !busy, !isCapturing, let api, let meeting, meeting.status != .ended else { return }
        busy = true; defer { busy = false }
        do {
            if !queue.isEmpty { await retryUploads(); guard queue.isEmpty else { throw GlanceError.message("Reconnect the service and retry pending transcript updates before starting.") } }
            let updated = try await api.control(id: meeting.id, action: .resume)
            apply(updated)
            isCapturing = true
            listeningAcknowledged = false
            hasHeardSpeech = false
            recognizedFinalCount = 0
            loadingText = "Starting glasses microphone…"
            updateDisplay()
            NativeDiagnostics.record(["startStage": "starting-microphone", "configuredInputRoute": inputRoute.rawValue])
            if inputRoute == .glasses {
                captureStatus = "Starting glasses microphone…"
                try await glasses.start(useGlassesSpeech: true)
            } else {
                captureStatus = "Starting phone microphone…"
                try await phone.start()
            }
            errorMessage = nil
            focus = .listening
            updateDisplay()
        } catch { stopCapture(); showStartError(error) }
    }

    private func showStartError(_ error: Error) {
        let failure = error as NSError
        let message: String
        if failure.domain == NSURLErrorDomain || error is MeetingAPIError {
            message = "Couldn’t connect to kompX. Try again."
        } else { message = error.localizedDescription }
        errorMessage = message
        startFailureMessage = message
        NativeDiagnostics.record(["startStage": "failed", "startErrorDomain": failure.domain, "startErrorCode": String(failure.code)])
        glasses.render(GlassesCard(title: "kompX", body: String(message.prefix(260)), primaryLabel: "Start", primary: { [weak self] in Task { await self?.startListening(source: "lens") } }, showsSecondary: false))
    }

    func pause() async {
        guard !busy, let api, let meeting else { return }
        busy = true; defer { busy = false }
        finalizePartial()
        stopCapture()
        captureStatus = "Paused · microphone off"
        await drainUploads()
        guard queue.isEmpty else {
            errorMessage = "Microphone off. Retry pending speech before pausing the shared meeting."
            focus = .listening; updateDisplay()
            return
        }
        do { apply(try await api.control(id: meeting.id, action: .pause)) }
        catch { errorMessage = error.localizedDescription }
        focus = .listening; updateDisplay()
    }

    func end() async {
        guard !busy, let api, let meeting else { return }
        busy = true; defer { busy = false }
        finalizePartial()
        stopCapture()
        captureStatus = "Ending meeting · microphone off"
        await drainUploads()
        guard queue.isEmpty else { errorMessage = "The microphone is off. Reconnect and retry pending transcript updates, then end the meeting again."; return }
        do {
            apply(try await api.end(id: meeting.id))
            captureStatus = "Meeting ended · microphone off"
            focus = .summary; pagerKey = ""; updateDisplay()
        } catch { errorMessage = error.localizedDescription }
    }

    private func stopCapture() {
        let wasCapturing = isCapturing
        isCapturing = false
        if wasCapturing, meeting?.status == .listening, !partialTranscript.isEmpty,
           let final = tracker.submit(text: partialTranscript, isFinal: true) {
            queue.append(final)
            pendingUploadCount = queue.count
            partialTranscript = ""
            beginUpload()
        }
        if inputRoute == .phone || phone.isRunning { phone.stop() }
        glasses.pauseSpeech()
    }

    private func finalizePartial() {
        if !partialTranscript.isEmpty { receiveTranscript(partialTranscript, isFinal: true) }
    }

    private func receiveTranscript(_ text: String, isFinal: Bool) {
        NativeDiagnostics.record(["captureIntentAtTranscript": String(isCapturing)])
        guard isCapturing else { NativeDiagnostics.record(["transcriptIgnoredReason": "capture-not-active"]); return }
        guard let segment = tracker.submit(text: text, isFinal: isFinal) else {
            NativeDiagnostics.record(["transcriptIgnoredReason": text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "empty-result" : "duplicate-final"])
            return
        }
        hasHeardSpeech = true
        NativeDiagnostics.increment("acceptedTranscriptUpdateCount")
        if isFinal { recognizedFinalCount += 1; NativeDiagnostics.increment("acceptedFinalTranscriptCount") }
        NativeDiagnostics.record(["transcriptIgnoredReason": ""])
        partialTranscript = isFinal ? "" : text
        NativeDiagnostics.record(["lastNativeTranscriptAt": ISO8601DateFormatter().string(from: Date()), "configuredInputRoute": inputRoute.rawValue])
        // Keep only the newest pending partial revision for a segment. Finals are never dropped.
        if !isFinal, let last = queue.last, !last.isFinal, last.segmentId == segment.segmentId { queue[queue.count - 1] = segment }
        else { queue.append(segment) }
        pendingUploadCount = queue.count
        if queue.count > 100 {
            stopCapture()
            captureStatus = "Paused · service backlog"
            errorMessage = "Too many transcript updates are waiting. The microphone stopped; retry uploads before resuming."
        }
        beginUpload()
        if diagnosticKeepDisplayActive { updateDisplay() }
    }

    private func beginUpload() {
        guard uploadTask == nil, let api, let id = meeting?.id, !queue.isEmpty else { return }
        let generation = revisionGeneration
        uploadTask = Task { [weak self] in
            guard let self else { return }
            defer { self.uploadTask = nil }
            while let item = self.queue.first, !Task.isCancelled, self.revisionGeneration == generation {
                do {
                    _ = try await api.appendTranscript(id: id, segment: item)
                    NativeDiagnostics.increment("transcriptUploadCount")
                    NativeDiagnostics.record(["lastTranscriptUploadAt": ISO8601DateFormatter().string(from: Date())])
                    if self.queue.first == item { self.queue.removeFirst() }
                    self.pendingUploadCount = self.queue.count
                } catch {
                    self.stopCapture()
                    self.captureStatus = "Paused · transcript upload failed"
                    self.errorMessage = "Transcript is pending on this phone: \(error.localizedDescription)"
                    return
                }
            }
        }
    }

    private func drainUploads() async { beginUpload(); await uploadTask?.value }
    func retryUploads() async { await drainUploads() }

    private func observeEvents(client: MeetingAPI, id: String, generation: Int) {
        eventTask = Task { [weak self] in
            var delay: UInt64 = 1
            while !Task.isCancelled {
                guard let self, self.revisionGeneration == generation else { return }
                do {
                    self.connectionStatus = "Connecting live meeting…"
                    let stream = await client.events(id: id)
                    for try await event in stream {
                        guard !Task.isCancelled, self.revisionGeneration == generation else { return }
                        self.connectionStatus = "Live meeting connected"
                        delay = 1
                        switch event {
                        case .snapshot(let snapshot): self.apply(snapshot)
                        case .error(let message): self.errorMessage = message
                        default: self.scheduleRefresh(client: client, id: id, generation: generation)
                        }
                    }
                } catch {
                    guard !Task.isCancelled else { return }
                    self.connectionStatus = "Live connection lost · reconnecting"
                }
                do { self.apply(try await client.snapshot(id: id)) } catch { }
                try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
                delay = min(delay * 2, 15)
            }
        }
    }

    private func scheduleRefresh(client: MeetingAPI, id: String, generation: Int) {
        guard refreshTask == nil else { return }
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(150))
            guard let self else { return }
            defer { self.refreshTask = nil }
            guard !Task.isCancelled, self.revisionGeneration == generation else { return }
            do { self.apply(try await client.snapshot(id: id)) }
            catch { self.connectionStatus = "Waiting for meeting sync" }
        }
    }

    private func apply(_ snapshot: MeetingSnapshot) {
        guard snapshot.id == meeting?.id, snapshot.revision >= (meeting?.revision ?? 0) else { return }
        let old = meeting
        meeting = snapshot
        NativeDiagnostics.record(["meetingStatus": snapshot.status.rawValue, "transcriptSegmentCount": String(snapshot.transcript.count)])
        if snapshot.status == .ended || snapshot.status == .paused {
            stopCapture()
            captureStatus = snapshot.status == .ended ? "Meeting ended · microphone off" : "Paused · microphone off"
        }
        if snapshot.calendarAction != old?.calendarAction, focus == .action { pagerKey = ""; displayedAction = nil }
        if snapshot.deliveryAction != old?.deliveryAction, focus == .delivery { pagerKey = ""; displayedDelivery = nil }
        if let delivery = snapshot.deliveryAction {
            NativeDiagnostics.record(["deliveryStatus": delivery.status.rawValue, "deliveryReceiptPresent": String(delivery.providerMessageId != nil)])
            if delivery.status == .proposed, delivery != old?.deliveryAction {
                offerFollowUpNotice(("Ready to send", "Review the recipient and attachment.", .delivery))
            }
        }
        if snapshot.cue != old?.cue, focus == .listening || focus == .cue {
            focus = snapshot.cue == nil ? .listening : .cue
            if let notice = transientNotice, notice.focus == .tasks || notice.focus == .action || notice.focus == .delivery { pendingFollowUpNotice = notice }
            transientNotice = nil
            pagerKey = ""
            if snapshot.cue != nil { expireTransient(after: 8) }
        }
        do {
            if let action = snapshot.calendarAction, action.status == .proposed,
               action != old?.calendarAction {
                offerFollowUpNotice(("Invitation ready", "Review \(action.title) before sending.", .action))
            } else if let working = snapshot.tasks.first(where: { task in
                (task.status == .queued || task.status == .running) && old?.tasks.first(where: { $0.id == task.id })?.status != task.status
            }) {
                selectedTaskID = working.id
                if focus == .listening {
                    transientNotice = ("kompX", "Working on \(working.title)…", .tasks)
                    expireTransient(after: 8)
                }
            } else if let completed = snapshot.tasks.first(where: { task in
                (task.status == .completed || task.status == .reviewRequired) && old?.tasks.first(where: { $0.id == task.id }) != task
            }) {
                selectedTaskID = completed.id
                offerFollowUpNotice(("Task ready", completed.title, .tasks))
            }
        }
        if snapshot.summary != old?.summary, snapshot.summary != nil, snapshot.status == .ended,
           focus == .listening || focus == .cue || focus == .summary || focus == .controls {
            focus = .summary; pagerKey = ""
        }
        updateDisplay()
    }

    func confirm(_ action: CalendarAction) async {
        guard !busy, let api, let meeting else { return }
        guard meeting.calendarAction == action, action.status == .proposed else { errorMessage = "This invitation changed. Review the latest preview before confirming."; return }
        busy = true; defer { busy = false }
        do {
            _ = try await api.confirm(id: meeting.id, actionId: action.id, proposalVersion: action.proposalVersion)
            apply(try await api.snapshot(id: meeting.id))
            focus = .action; pagerKey = ""; updateDisplay()
        } catch { errorMessage = error.localizedDescription; scheduleRefresh(client: api, id: meeting.id, generation: revisionGeneration) }
    }

    func prepareDelivery(for task: MeetingTask) async {
        guard !busy, let api, let meeting else { return }
        guard meeting.tasks.first(where: { $0.id == task.id }) == task,
              let generation = task.generation, let context = task.contextDigest,
              let artifact = task.artifactDigest, task.content != nil,
              task.status == .reviewRequired || task.status == .completed else {
            showTaskError("This document changed. Review its latest version.")
            return
        }
        busy = true; defer { busy = false }
        do {
            if task.status == .reviewRequired {
                apply(try await api.reviewTask(id: meeting.id, taskId: task.id, generation: generation, contextDigest: context))
            }
            reviewedDocumentIdentity = (task.id, generation, artifact, context)
            let snapshot = try await api.proposeDelivery(id: meeting.id, taskId: task.id)
            apply(snapshot)
            guard let delivery = snapshot.deliveryAction, isReviewed(delivery) else {
                throw GlanceError.message("The document changed before delivery. Review the new version.")
            }
            pendingFollowUpNotice = nil; transientNotice = nil
            focus = .delivery; pagerKey = ""; updateDisplay()
        } catch { showTaskError("Couldn’t prepare delivery. Review the latest document and try again.") }
    }

    private func isReviewed(_ action: DocumentDeliveryAction) -> Bool {
        guard let reviewed = reviewedDocumentIdentity else { return false }
        return reviewed.taskId == action.taskId && reviewed.generation == action.generation
            && reviewed.artifactDigest == action.artifactDigest && reviewed.contextDigest == action.contextDigest
    }

    func confirmDelivery(_ action: DocumentDeliveryAction) async {
        guard !busy, let api, let meeting else { return }
        guard meeting.deliveryAction == action, action.status == .proposed, isReviewed(action) else {
            showTaskError("This delivery changed. Review the current document and preview.")
            return
        }
        busy = true; defer { busy = false }
        do {
            apply(try await api.confirmDelivery(id: meeting.id, deliveryId: action.id, proposalVersion: action.proposalVersion))
            focus = .delivery; pagerKey = ""; updateDisplay()
        } catch {
            // A lost response is not proof that a send failed. Refresh its durable status.
            if let snapshot = try? await api.snapshot(id: meeting.id) { apply(snapshot) }
            errorMessage = "Check the delivery status before trying again."
            focus = .delivery; pagerKey = ""; updateDisplay()
        }
    }

    private func showTaskError(_ message: String) {
        errorMessage = message
        glasses.render(GlassesCard(title: "kompX", body: message, primaryLabel: "Review", secondaryLabel: "Back", primary: { [weak self] in self?.focus = .tasks; self?.pagerKey = ""; self?.updateDisplay() }, secondary: { [weak self] in self?.returnToListening() }))
    }

    func leaveMeeting() {
        guard !isCapturing, queue.isEmpty else { return }
        revisionGeneration += 1
        eventTask?.cancel(); eventTask = nil
        refreshTask?.cancel(); refreshTask = nil
        uploadTask?.cancel(); uploadTask = nil
        meeting = nil; api = nil
        UserDefaults.standard.removeObject(forKey: "active-meeting-id")
        partialTranscript = ""
        captureStatus = "Ready to listen"
        connectionStatus = "Service not connected"
        glasses.pauseSpeech()
    }

    func displayPrimary() { primary?() }
    func displaySecondary() { secondary?() }

    private func offerFollowUpNotice(_ notice: (title: String, body: String, focus: GlassesFocus)) {
        // Keep completed work/review offers reachable without a permanent Tasks menu.
        // An open detail/review is never replaced by the incoming notice.
        if focus == notice.focus { return }
        if focus == .listening {
            transientTask?.cancel()
            transientNotice = notice
        } else { pendingFollowUpNotice = notice }
    }

    private func returnToListening() {
        showingPreloadedBrief = false
        transientTask?.cancel()
        transientNotice = pendingFollowUpNotice
        pendingFollowUpNotice = nil
        focus = .listening
        pagerKey = ""
        updateDisplay()
    }

    private func nextFocus() {
        transientTask?.cancel(); transientNotice = nil
        let choices = GlassesFocus.allCases
        focus = choices[(choices.firstIndex(of: focus)! + 1) % choices.count]
        pagerKey = ""
        updateDisplay()
    }

    private func expireTransient(after seconds: Double) {
        transientTask?.cancel()
        transientTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled, let self, !self.showingPreloadedBrief else { return }
            if self.focus == .cue || self.focus == .listening {
                self.returnToListening()
            }
        }
    }

    private func updateDisplay() {
        if showingPreloadedBrief {
            glasses.render(GlassesCard(title: PreloadedCompanyBrief.title, body: PreloadedCompanyBrief.body, primaryLabel: "Done", primary: { [weak self] in self?.returnToListening() }, showsSecondary: false, identity: "preloaded-liquid-energy-v1", isContextCard: true, captureLabel: isCapturing ? "Pause" : "Start", captureAction: { [weak self] in self?.toggleExplicitCapture() }, sourceLabel: PreloadedCompanyBrief.provenance))
            return
        }
        if (startOperationActive || isCapturing), !microphoneActive {
            glasses.render(GlassesCard(title: "kompX", body: loadingText, showsButtons: false))
            return
        }
        if focus == .listening, transientNotice == nil {
            let body = startFailureMessage ?? ""
            displayTitle = "kompX"; displayBody = body
            displayPrimaryLabel = isCapturing ? "Pause" : "Start"; displaySecondaryLabel = ""
            primary = { [weak self] in self?.toggleExplicitCapture() }
            secondary = nil
            glasses.render(GlassesCard(title: "kompX", body: body, primaryLabel: displayPrimaryLabel, primary: primary, showsSecondary: false, identity: "home-preloaded-brief", brandAction: { [weak self] in self?.showPreloadedBrief() }))
            return
        }
        if let message = startFailureMessage, !isCapturing, focus == .listening {
            glasses.render(GlassesCard(title: "kompX", body: message, primaryLabel: "Start", primary: { [weak self] in Task { await self?.startListening(source: "lens") } }, showsSecondary: false))
            return
        }
        guard let meeting else {
            glasses.render(GlassesCard(title: "kompX", body: "", primaryLabel: "Start", primary: { [weak self] in
                Task { await self?.startListening(source: "lens") }
            }, showsSecondary: false))
            return
        }
        if focus == .listening, isCapturing, microphoneActive, transientNotice == nil {
            displayTitle = "Listening quietly"
            displayBody = ""
            if diagnosticKeepDisplayActive {
                glasses.render(GlassesCard(title: "kompX", body: hasHeardSpeech ? "Listening" : "Awaiting speech", primaryLabel: "Pause", primary: { [weak self] in Task { await self?.pause() } }, showsSecondary: false))
            } else { glasses.clear() }
            return
        }
        var heading = microphoneActive ? "Listening" : (isCapturing ? "Connecting" : "kompX")
        var text = isCapturing ? "Stay in the conversation. A useful cue will appear when it is ready." : "Microphone off."
        if isCapturing && !microphoneActive { text = "Connecting microphone. Speech is not active yet." }
        var key = "listening-\(isCapturing)-\(microphoneActive)"
        var primaryLabel = "View cue"
        var primaryAction: () -> Void = { [weak self] in self?.focus = .cue; self?.pagerKey = ""; self?.updateDisplay() }
        switch focus {
        case .listening:
            if let notice = transientNotice {
                heading = notice.title; text = notice.body; key = "notice-" + text
                if notice.focus == .listening {
                    primaryLabel = "Pause"
                    primaryAction = { [weak self] in Task { await self?.pause() } }
                } else {
                    primaryLabel = "Review"
                    primaryAction = { [weak self] in
                        self?.focus = notice.focus; self?.transientNotice = nil; self?.transientTask?.cancel(); self?.pagerKey = ""; self?.updateDisplay()
                    }
                }
            } else if !isCapturing {
                primaryLabel = "Start"
                primaryAction = { [weak self] in Task { await self?.startListening(source: "lens") } }
            }
        case .cue:
            heading = "A useful thought"
            text = meeting.cue?.text ?? "Nothing to add right now. Stay with the conversation."
            key = "cue-\(meeting.cue?.id ?? "none")-\(meeting.cue?.revision ?? 0)"
            primaryLabel = "Details"
            primaryAction = { [weak self] in self?.focus = .details; self?.pagerKey = ""; self?.updateDisplay() }
        case .details:
            heading = "Why this cue"
            text = [meeting.cue?.detail ?? "No cue details yet.", meeting.cue?.evidence.map { "\($0.label): \($0.text)" }.joined(separator: "\n\n") ?? ""].joined(separator: "\n\n")
            key = "details-\(meeting.cue?.id ?? "none")-\(meeting.cue?.revision ?? 0)"
        case .summary:
            heading = "Meeting summary"
            text = meeting.summary.map { [$0.text, "Decisions: " + $0.decisions.joined(separator: "; "), "Next: " + $0.nextSteps.joined(separator: "; ")].joined(separator: "\n\n") } ?? (meeting.status == .ended ? "Preparing the meeting summary…" : "End the meeting to prepare a summary and follow-up work.")
            key = "summary-\(meeting.summary?.revision ?? -1)"
        case .tasks:
            heading = "Document review"
            let task = meeting.tasks.first(where: { $0.id == selectedTaskID }) ?? meeting.tasks.last
            displayedTask = task
            if let task {
                if let generation = task.generation { heading += " · v\(generation)" }
                text = "\(task.title)\n\n\(task.content ?? task.error ?? task.status.rawValue.replacingOccurrences(of: "_", with: " "))"
                key = "task-\(task.id)-\(task.generation ?? 0)-\(task.artifactDigest ?? "")-\(task.contextDigest ?? "")-\(task.status.rawValue)"
            } else { text = "No document yet."; key = "task-none" }
        case .controls:
            heading = "Meeting controls"
            text = isCapturing ? "Pause listening or finish this meeting." : "Microphone off. Resume or finish this meeting."
            key = "controls-\(isCapturing)"
            primaryLabel = isCapturing ? "Pause" : "Resume"
            primaryAction = { [weak self] in
                guard let self else { return }
                Task { if self.isCapturing { await self.pause() } else { await self.startListening() } }
            }
        case .delivery:
            heading = "Delivery preview"
            if let delivery = meeting.deliveryAction {
                displayedDelivery = delivery
                let recipient = delivery.recipient.name.map { "\($0) <\(delivery.recipient.email)>" } ?? delivery.recipient.email
                text = "To: \(recipient)\nSubject: \(delivery.subject)\n\n\(delivery.body)\n\nAttachment: \(delivery.filename) · v\(delivery.generation)\nStatus: \(delivery.status.rawValue)"
                if delivery.status == .sent { heading = "Sent"; text = "Sent to \(recipient).\n\(delivery.filename)" }
                key = "delivery-\(delivery.id)-\(delivery.proposalVersion)-\(delivery.artifactDigest)-\(delivery.status.rawValue)"
            } else { displayedDelivery = nil; text = "No delivery preview yet."; key = "delivery-none" }
        case .action:
            heading = "Invitation preview"
            if let action = meeting.calendarAction {
                text = "\(action.title)\n\(action.start) → \(action.end)\nTime zone: \(action.timeZone)\nTo: \(action.attendees.map { attendee in attendee.name.map { "\($0) <\(attendee.email)>" } ?? attendee.email }.joined(separator: ", "))\n\(action.description)\nProposal \(action.proposalVersion) · \(action.status.rawValue)"
                key = "action-\(action.id)-\(action.proposalVersion)-\(action.status.rawValue)"
                displayedAction = action
            } else { text = "No invitation proposed yet."; key = "action-none"; displayedAction = nil }
        }
        if pagerKey != key { pager = DisplayPagination(text: text); pagerKey = key }
        if pager.pages.count > 1 { heading += " \(pager.index + 1)/\(pager.pages.count)" }
        if !pager.isLast {
            primaryLabel = "Read next"
            primaryAction = { [weak self] in self?.pager.next(); self?.updateDisplay() }
        } else if focus == .tasks, let task = displayedTask,
                  (task.status == .reviewRequired || task.status == .completed), task.content != nil {
            primaryLabel = "Prepare send"
            primaryAction = { [weak self] in Task { await self?.prepareDelivery(for: task) } }
        } else if focus == .delivery, let delivery = displayedDelivery, delivery.status == .proposed {
            if isReviewed(delivery) {
                primaryLabel = "Send"
                primaryAction = { [weak self] in Task { await self?.confirmDelivery(delivery) } }
            } else {
                primaryLabel = "Review document"
                primaryAction = { [weak self] in self?.selectedTaskID = delivery.taskId; self?.focus = .tasks; self?.pagerKey = ""; self?.updateDisplay() }
            }
        } else if focus == .action, let action = displayedAction, action.status == .proposed {
            primaryLabel = "Confirm invite"
            primaryAction = { [weak self] in Task { await self?.confirm(action) } }
        } else if focus != .cue && focus != .listening && focus != .controls {
            primaryLabel = "Done"
            primaryAction = { [weak self] in self?.returnToListening() }
        }
        displayTitle = heading; displayBody = pager.current
        let hasContextNotice = focus == .listening && transientNotice != nil && transientNotice?.focus != .listening
        let showsSecondary = (focus != .listening && primaryLabel != "Done") || hasContextNotice
        let secondaryLabel = hasContextNotice ? (isCapturing ? "Pause" : "Start") : "Back"
        displayPrimaryLabel = primaryLabel; displaySecondaryLabel = secondaryLabel
        primary = primaryAction
        if hasContextNotice {
            secondary = { [weak self] in guard let self else { return }; Task { if self.isCapturing { await self.pause() } else { await self.startListening(source: "lens") } } }
        } else { secondary = { [weak self] in self?.returnToListening() } }
        glasses.render(GlassesCard(title: heading, body: pager.current, primaryLabel: primaryLabel, secondaryLabel: secondaryLabel, primary: primaryAction, secondary: secondary, showsSecondary: showsSecondary, identity: key + "-\(pager.index)", isContextCard: focus == .cue && meeting.cue != nil, captureLabel: isCapturing ? "Pause" : "Start", captureAction: { [weak self] in
            guard let self else { return }
            Task { if self.isCapturing { await self.pause() } else { await self.startListening(source: "lens") } }
        }, sourceLabel: meeting.cue?.evidence.isEmpty == false ? "Sources in Details" : "Context"))

    }

    private func showPreloadedBrief() {
        transientTask?.cancel()
        showingPreloadedBrief = true
        NativeDiagnostics.record(["lastPreloadedBriefOpenedAt": ISO8601DateFormatter().string(from: Date())])
        updateDisplay()
    }

    private func toggleExplicitCapture() {
        Task { if isCapturing { await pause() } else { await startListening(source: "lens") } }
    }
}
