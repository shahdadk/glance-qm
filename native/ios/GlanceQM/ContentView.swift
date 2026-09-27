import SwiftUI
import UniformTypeIdentifiers

/// A minimal companion to the Meta Display experience. Meeting IDs and service
/// configuration are not part of the wearer's everyday interaction.
struct ContentView: View {
    @ObservedObject var model: MeetingViewModel
    @ObservedObject var glasses: MetaGlassesController
    @Environment(\.scenePhase) private var scenePhase
    @State private var settingsOpen = false
    @State private var importOpen = false
    @State private var selectedTab = 0

    var body: some View {
        TabView(selection: $selectedTab) {
            NavigationStack {
                live
                    .navigationTitle("kompX")
                    .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Settings", systemImage: "gearshape") { settingsOpen = true } } }
            }.tabItem { Label("Live", systemImage: "waveform") }.tag(0)
            NavigationStack { tasks.navigationTitle("Tasks") }.tabItem { Label("Tasks", systemImage: "checklist") }.tag(1)
            NavigationStack { summary.navigationTitle("Summary") }.tabItem { Label("Summary", systemImage: "text.alignleft") }.tag(2)
        }
        .tint(Color("GlanceAccent"))
        .sheet(isPresented: $settingsOpen) { settings }
        .onOpenURL { url in
            if url.scheme == "glanceqm", url.host == "connect" {
                Task { await glasses.register() }
            } else if url.scheme == "glanceqm", url.host == "meeting", let id = url.pathComponents.last, id != "/" {
                Task { await model.joinFromLink(id) }
            } else { Task { await glasses.handleURL(url) } }
        }
        .onChange(of: scenePhase) { _, phase in NativeDiagnostics.recordScene(String(describing: phase)) }
        .onAppear { NativeDiagnostics.recordScene(String(describing: scenePhase)) }
        .onChange(of: model.meeting?.status) { _, status in if status == .ended { selectedTab = 2 } }
    }

    private var live: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                HStack(spacing: 12) {
                    Image(systemName: model.isCapturing ? "waveform" : "eyeglasses").font(.title2)
                    VStack(alignment: .leading, spacing: 4) {
                        if model.isCapturing { Text(model.microphoneActive ? (model.hasHeardSpeech ? "Listening" : "Awaiting speech") : "Connecting…").font(.headline) }
                        Text(model.inputRoute == .glasses ? (glasses.speechReady ? "Glasses microphone" : "Meta glasses") : "Phone test microphone")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if model.busy { ProgressView().accessibilityLabel("Connecting") }
                }
                if let message = model.errorMessage {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(message).font(.subheadline)
                        Button("Open settings") { settingsOpen = true }
                    }.padding().frame(maxWidth: .infinity, alignment: .leading).background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                }
                if let cue = model.meeting?.cue {
                    VStack(alignment: .leading, spacing: 14) {
                        Text(cue.text).font(.title2).fixedSize(horizontal: false, vertical: true)
                        if let detail = cue.detail {
                            DisclosureGroup("More") {
                                Text(detail).font(.body).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
                                ForEach(cue.evidence, id: \.id) { evidence in
                                    Text("\(evidence.label) · \(evidence.text)").font(.footnote).foregroundStyle(.secondary).padding(.top, 6)
                                }
                            }
                        }
                    }
                } else if model.isCapturing {
                    Text(model.microphoneActive ? (model.hasHeardSpeech ? "Listening." : "Awaiting speech from the glasses.") : "Connecting…").font(.title2).foregroundStyle(.secondary).padding(.vertical, 20)
                }
                if model.isCapturing {
                    HStack(spacing: 12) {
                        Button { Task { await model.pause() } } label: { Label("Pause", systemImage: "pause.fill").frame(maxWidth: .infinity).padding(.vertical, 8) }.buttonStyle(.borderedProminent)
                        Button("End meeting") { Task { await model.end() } }.buttonStyle(.bordered).padding(.vertical, 8)
                    }.disabled(model.busy)
                    Text(model.microphoneActive ? "Microphone is on. Everyone should know the meeting is being transcribed." : "Waiting for microphone permission or connection.").font(.footnote).foregroundStyle(.secondary)
                } else {
                    Button { Task { await model.startListening() } } label: {
                        Text("Start").frame(maxWidth: .infinity).padding(.vertical, 10)
                    }.buttonStyle(.borderedProminent).disabled(model.busy)
                    if let meeting = model.meeting, meeting.status != .ended {
                        Button("End meeting") { Task { await model.end() } }.disabled(model.busy)
                    }
                    Text("Listening starts only when you tap Start.").font(.footnote).foregroundStyle(.secondary)
                }
                if model.pendingUploadCount > 0 {
                    Button("Retry pending speech") { Task { await model.retryUploads() } }.font(.footnote)
                }
            }.padding(24)
        }
    }

    private var tasks: some View {
        List {
            if let meeting = model.meeting, !meeting.tasks.isEmpty {
                ForEach(meeting.tasks, id: \.id) { task in
                    DisclosureGroup {
                        if let content = task.content { Text(content).font(.body) }
                        if let error = task.error { Text(error).foregroundStyle(.red) }
                        if let raw = task.url, let url = URL(string: raw), ["https", "http"].contains(url.scheme ?? "") { Link("Open result", destination: url) }
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(task.title)
                            Text(task.status.rawValue.capitalized).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            } else {
                Text("Agreed follow-up work will appear here.").foregroundStyle(.secondary).listRowSeparator(.hidden)
            }
            if let action = model.meeting?.calendarAction {
                Section("Invitation") { calendarPreview(action) }
            }
        }.listStyle(.plain)
    }

    private var summary: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if let summary = model.meeting?.summary {
                    Text(summary.text).font(.body)
                    if !summary.decisions.isEmpty {
                        Text("Decisions").font(.headline)
                        ForEach(Array(summary.decisions.enumerated()), id: \.offset) { _, text in Text(text) }
                    }
                    if !summary.nextSteps.isEmpty {
                        Text("Next steps").font(.headline)
                        ForEach(Array(summary.nextSteps.enumerated()), id: \.offset) { _, text in Text(text) }
                    }
                    if !summary.openQuestions.isEmpty {
                        Text("Still open").font(.headline)
                        ForEach(Array(summary.openQuestions.enumerated()), id: \.offset) { _, text in Text(text) }
                    }
                } else {
                    Text(model.meeting?.status == .ended ? "Preparing your summary…" : "End the meeting to see the decisions and next steps.").foregroundStyle(.secondary)
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(24)
        }
    }

    private func calendarPreview(_ action: CalendarAction) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(action.title).font(.headline)
            Text("\(action.start) – \(action.end)\n\(action.timeZone)").font(.subheadline)
            Text(action.attendees.map { attendee in attendee.name.map { "\($0) <\(attendee.email)>" } ?? attendee.email }.joined(separator: "\n")).font(.subheadline)
            Text(action.description).font(.body)
            Text(action.status.rawValue.capitalized).font(.caption).foregroundStyle(.secondary)
            if action.status == .proposed {
                Button("Confirm invitation") { Task { await model.confirm(action) } }.buttonStyle(.borderedProminent).disabled(model.busy)
                Text("Sends this exact invitation.").font(.caption).foregroundStyle(.secondary)
            }
        }.padding(.vertical, 8)
    }

    private var settings: some View {
        NavigationStack {
            Form {
                Section("Glasses") {
                    Text(glasses.registration.capitalized)
                    Text(glasses.status).font(.footnote).foregroundStyle(.secondary)
                    Button("Connect with Meta AI") { Task { await glasses.register() } }
                    Button("Connect display") { Task { await model.connectDisplay() } }.disabled(model.isCapturing || model.busy)
                    if glasses.needsGlassesUpdate { Button("Update glasses app") { Task { await glasses.updateGlasses() } } }
                }
                Section("Microphone") {
                    Text(model.inputRoute == .glasses ? "Meta glasses microphone" : "Phone test input — not a glasses demonstration")
                    Text("Start may open Meta AI for microphone permission.").font(.footnote).foregroundStyle(.secondary)
                }
                if let id = model.meeting?.id, let url = URL(string: "glanceqm://meeting/\(id)") {
                    Section { ShareLink("Invite a participant", item: url) }
                }
                Section {
                    DisclosureGroup("Advanced connection") {
                        TextField("Service URL", text: $model.backendURL).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        SecureField("Access token", text: $model.token).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Button("Save securely") { model.saveConfiguration() }
                        Button("Import connection file") { importOpen = true }
                            .fileImporter(isPresented: $importOpen, allowedContentTypes: [.json]) { result in
                                do { try model.importPairing(result.get()) }
                                catch { model.errorMessage = error.localizedDescription }
                            }
                        DisclosureGroup("Diagnostics / phone test") {
                            Toggle("Keep lens visible", isOn: $model.diagnosticKeepDisplayActive)
                            Text("Off enables experimental quiet display. Sustained Speech with the display cleared still needs hardware verification.").font(.caption)
                            Toggle("Use iPhone microphone for testing", isOn: Binding(get: { model.inputRoute == .phone }, set: { model.inputRoute = $0 ? .phone : .glasses }))
                            Text("Test input only. This uses Apple Speech and the iPhone microphone, not the glasses.").font(.caption)
                        }
                        Text(model.connectionStatus).font(.caption)
                        ForEach(glasses.devices, id: \.self) { Text($0).font(.caption) }
                    }.disabled(model.isCapturing)
                }
            }.navigationTitle("Settings").toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { settingsOpen = false } } }
        }
    }
}
