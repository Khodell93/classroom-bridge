import ReplayKit
import SwiftUI

@main
struct ClassroomBridgeApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

struct ContentView: View {
    @State private var code = SharedSettings.pairingCode
    @State private var showHelp = false

    var body: some View {
        VStack(spacing: 28) {
            VStack(spacing: 8) {
                Image(systemName: "rectangle.on.rectangle.angled")
                    .font(.system(size: 54))
                    .foregroundStyle(.tint)
                Text("Classroom Bridge").font(.largeTitle.bold())
                Text("Share this iPad's whole screen to the classroom display, then use OneDrive, PowerPoint or any app with Apple Pencil.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: 520)
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("PAIRING CODE").font(.caption.bold()).foregroundStyle(.secondary)
                TextField("12-character code from the PC or Mac", text: $code)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .font(.system(.title2, design: .monospaced))
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: code) { newValue in
                        let cleaned = SharedSettings.normalise(newValue)
                        if cleaned != newValue { code = cleaned }
                        SharedSettings.pairingCode = cleaned
                    }
                Text("Saved on this iPad. Start the companion on the PC or Mac first.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            .frame(maxWidth: 420)

            VStack(spacing: 10) {
                BroadcastPicker(enabled: code.count == 12)
                    .frame(width: 280, height: 56)
                Text(code.count == 12 ? "Tap, then choose Start Broadcast." : "Enter the 12-character code to continue.")
                    .font(.footnote).foregroundStyle(.secondary)
            }

            Button("How it works") { showHelp = true }
        }
        .padding(32)
        .sheet(isPresented: $showHelp) { HelpView() }
    }
}

/// Wraps Apple's system broadcast button, restricted to this app's extension.
struct BroadcastPicker: UIViewRepresentable {
    let enabled: Bool

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 280, height: 56))
        picker.preferredExtension = SharedSettings.extensionBundleID
        picker.showsMicrophoneButton = false
        picker.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        // The system's own button is a small glyph; style it as a full-width call to action.
        if let button = picker.subviews.compactMap({ $0 as? UIButton }).first {
            var configuration = UIButton.Configuration.filled()
            configuration.title = "Share iPad screen"
            configuration.image = UIImage(systemName: "play.rectangle.fill")
            configuration.imagePadding = 8
            configuration.cornerStyle = .large
            button.configuration = configuration
        }
        container.addSubview(picker)
        return container
    }

    func updateUIView(_ view: UIView, context: Context) {
        view.isUserInteractionEnabled = enabled
        view.alpha = enabled ? 1 : 0.4
    }
}

struct HelpView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationView {
            List {
                Section("Teaching with iPad apps") {
                    Label("Start the Classroom Bridge companion on the PC or Mac and note its code.", systemImage: "1.circle")
                    Label("Enter the code here and tap Share iPad screen, then Start Broadcast.", systemImage: "2.circle")
                    Label("Switch to OneDrive, PowerPoint or a PDF app and mark up with Apple Pencil. Everything on the iPad appears full-screen on the classroom display.", systemImage: "3.circle")
                    Label("To stop, open Control Centre, tap the red recording indicator, then Stop Broadcast.", systemImage: "4.circle")
                }
                Section("Good to know") {
                    Text("Notifications and anything private on screen are shared too — turn on Do Not Disturb first.")
                    Text("Sign-in, saving and markup stay inside Microsoft's own apps; Classroom Bridge only transmits the picture.")
                    Text("Video passes through the Classroom Bridge relay (Cloudflare) as images and is not stored.")
                }
            }
            .navigationTitle("How it works")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .navigationViewStyle(.stack)
    }
}
