import SwiftUI

@main
struct GlanceQMApp: App {
    @StateObject private var model = MeetingViewModel()
    var body: some Scene { WindowGroup { ContentView(model: model, glasses: model.glasses) } }
}
