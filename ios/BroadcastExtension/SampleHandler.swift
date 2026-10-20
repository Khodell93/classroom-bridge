import CoreImage
import ReplayKit
import UIKit

/// Receives the iPad's screen from ReplayKit, compresses frames to JPEG and sends them to the PC companion
/// through the Classroom Bridge relay. Kept deliberately small: broadcast extensions have a tight memory limit.
final class SampleHandler: RPBroadcastSampleHandler {
    private let maxWidth: CGFloat = 1280
    private let minFrameInterval: CFTimeInterval = 1.0 / 8.0
    private let jpegQuality: CGFloat = 0.55
    private let ciContext = CIContext(options: [.cacheIntermediates: false])
    private let colorSpace = CGColorSpaceCreateDeviceRGB()
    private let lock = NSLock()
    private var session: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var sendInFlight = false
    private var lastFrameTime: CFTimeInterval = 0
    private var failed = false

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        guard SharedSettings.isValidCode, let url = SharedSettings.socketURL() else {
            finishBroadcastWithError(Self.error("Open Classroom Bridge and enter the 12-character pairing code first."))
            return
        }
        let session = URLSession(configuration: .default)
        let task = session.webSocketTask(with: url)
        self.session = session
        socket = task
        task.resume()
        task.send(.string(#"{"type":"screen-start"}"#)) { [weak self] error in
            if error != nil { self?.fail("Could not reach Classroom Bridge. Check the internet connection and the pairing code.") }
        }
        listen(task)
    }

    override func broadcastFinished() {
        socket?.send(.string(#"{"type":"screen-stop"}"#)) { _ in }
        // Give the stop notice a moment to leave before the connection closes.
        let task = socket
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { task?.cancel(with: .normalClosure, reason: nil) }
        socket = nil
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard sampleBufferType == .video, let socket, !failed else { return }
        let now = CACurrentMediaTime()
        lock.lock()
        let skip = sendInFlight || now - lastFrameTime < minFrameInterval
        if !skip { sendInFlight = true; lastFrameTime = now }
        lock.unlock()
        if skip { return }

        guard let jpeg = encode(sampleBuffer) else { finishSend(); return }
        socket.send(.data(jpeg)) { [weak self] error in
            if error != nil { self?.fail("Lost connection to Classroom Bridge.") }
            self?.finishSend()
        }
    }

    private func encode(_ sampleBuffer: CMSampleBuffer) -> Data? {
        guard let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return nil }
        var image = CIImage(cvPixelBuffer: pixels)
        if let raw = CMGetAttachment(sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber,
           let orientation = CGImagePropertyOrientation(rawValue: raw.uint32Value) {
            image = image.oriented(orientation)
        }
        let scale = min(1, maxWidth / image.extent.width)
        if scale < 1 { image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale)) }
        return ciContext.jpegRepresentation(
            of: image,
            colorSpace: colorSpace,
            options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: jpegQuality]
        )
    }

    private func finishSend() {
        lock.lock(); sendInFlight = false; lock.unlock()
    }

    /// The relay never sends anything we need, but a pending receive lets us notice a dropped connection.
    private func listen(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self, self.socket === task else { return }
            if case .failure = result { self.fail("Lost connection to Classroom Bridge."); return }
            self.listen(task)
        }
    }

    private func fail(_ message: String) {
        lock.lock()
        let alreadyFailed = failed
        failed = true
        lock.unlock()
        if !alreadyFailed { finishBroadcastWithError(Self.error(message)) }
    }

    private static func error(_ message: String) -> NSError {
        NSError(domain: "ClassroomBridge", code: 1, userInfo: [NSLocalizedFailureReasonErrorKey: message])
    }
}
