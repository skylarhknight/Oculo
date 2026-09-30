import ARKit
import AVFoundation
import Capacitor
import UIKit
import simd

/// Streams 6DoF device poses from ARKit world tracking into the WebView.
///
/// This plugin is a pose sensor only: it never renders the camera feed,
/// captures imagery, or exposes ARKit types to the web layer. Poses are
/// emitted as `pose` events in a right-handed, Y-up (gravity-aligned) world
/// frame, with the orientation corrected to the current interface orientation
/// so the web renderer can apply it directly to a screen-aligned camera.
@objc(ArPosePlugin)
public class ArPosePlugin: CAPPlugin, CAPBridgedPlugin, ARSessionDelegate {
    public let identifier = "ArPosePlugin"
    public let jsName = "ArPose"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    // Lifecycle operations and ARKit delegates share the main queue. A start
    // token also owns the permission reply, which may arrive after stop.
    private var session: ARSession?
    private var pendingStart: (id: UUID, call: CAPPluginCall)?
    private var interrupted = false
    private var lastInterfaceOrientation: UIInterfaceOrientation?
    private var lastTrackingState: String?
    private var lastPoseTimestamp: TimeInterval?

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": ARWorldTrackingConfiguration.isSupported])
    }

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("Motion tracking is no longer available.", "cancelled")
                return
            }
            self.beginStart(call)
        }
    }

    private func beginStart(_ call: CAPPluginCall) {
        guard ARWorldTrackingConfiguration.isSupported else {
            call.reject("World tracking is not supported on this device.", "unsupported-capability")
            return
        }
        if session != nil {
            publishTrackingState(interrupted ? "unavailable" : "initializing")
            call.resolve()
            return
        }
        cancelPendingStart()
        let startID = UUID()
        pendingStart = (startID, call)
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            runSession(startID)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.pendingStart?.id == startID else { return }
                    if granted {
                        self.runSession(startID)
                    } else {
                        self.rejectPendingStart(
                            "Camera access is required for motion tracking.", "unauthorized"
                        )
                    }
                }
            }
        default:
            rejectPendingStart("Camera access is required for motion tracking.", "unauthorized")
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.cancelPendingStart()
            self?.stopOwnedSession()
            self?.publishTrackingState("unavailable")
            call.resolve()
        }
    }

    private func cancelPendingStart() {
        rejectPendingStart("Motion tracking start was cancelled.", "cancelled")
    }

    private func rejectPendingStart(_ message: String, _ code: String) {
        let pending = pendingStart
        pendingStart = nil
        pending?.call.reject(message, code)
    }

    private func stopOwnedSession() {
        let previous = session
        session = nil
        previous?.delegate = nil
        previous?.pause()
        interrupted = false
        lastInterfaceOrientation = nil
        lastPoseTimestamp = nil
    }

    private func runSession(_ startID: UUID) {
        guard let pending = pendingStart, pending.id == startID else { return }
        pendingStart = nil
        stopOwnedSession()
        let session = ARSession()
        session.delegateQueue = .main
        session.delegate = self
        self.session = session
        let configuration = ARWorldTrackingConfiguration()
        configuration.worldAlignment = .gravity
        configuration.planeDetection = []
        publishTrackingState("initializing")
        session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
        pending.call.resolve()
    }

    private func publishTrackingState(_ state: String) {
        guard lastTrackingState != state else { return }
        lastTrackingState = state
        notifyListeners("trackingState", data: ["state": state])
    }

    private static func trackingStateName(_ camera: ARCamera) -> String {
        switch camera.trackingState {
        case .normal:
            return "normal"
        case .limited:
            return "limited"
        case .notAvailable:
            return "unavailable"
        }
    }

    // MARK: - ARSessionDelegate

    public func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard self.session === session, !interrupted else { return }
        guard case .normal = frame.camera.trackingState else {
            publishTrackingState(Self.trackingStateName(frame.camera))
            return
        }
        guard let interfaceOrientation = bridge?.webView?.window?.windowScene?.interfaceOrientation,
              interfaceOrientation != .unknown else {
            publishTrackingState("initializing")
            return
        }
        if let previous = lastInterfaceOrientation, previous != interfaceOrientation {
            lastInterfaceOrientation = interfaceOrientation
            // Freeze before any pose in the new screen basis. The next valid
            // frame announces normal so the web camera can take a new baseline.
            publishTrackingState("initializing")
            return
        }
        lastInterfaceOrientation = interfaceOrientation
        guard frame.timestamp.isFinite,
              lastPoseTimestamp.map({ frame.timestamp > $0 }) ?? true else { return }
        let transform = frame.camera.transform
        let position = transform.columns.3
        let orientation = simd_quatf(transform) * Self.interfaceOrientationCorrection(interfaceOrientation)
        guard [position.x, position.y, position.z, orientation.imag.x,
               orientation.imag.y, orientation.imag.z, orientation.real].allSatisfy({ $0.isFinite }) else {
            publishTrackingState("unavailable")
            return
        }
        lastPoseTimestamp = frame.timestamp
        publishTrackingState("normal")
        notifyListeners("pose", data: [
            "px": Double(position.x),
            "py": Double(position.y),
            "pz": Double(position.z),
            "qx": Double(orientation.imag.x),
            "qy": Double(orientation.imag.y),
            "qz": Double(orientation.imag.z),
            "qw": Double(orientation.real),
            "timestampMs": frame.timestamp * 1000
        ])
    }

    public func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        guard self.session === session, !interrupted else { return }
        // Only a usable normal frame can resume camera movement. A tracking
        // callback alone does not establish a pose or interface orientation.
        if case .normal = camera.trackingState { return }
        publishTrackingState(Self.trackingStateName(camera))
    }

    public func sessionWasInterrupted(_ session: ARSession) {
        guard self.session === session else { return }
        interrupted = true
        publishTrackingState("unavailable")
    }

    public func sessionInterruptionEnded(_ session: ARSession) {
        guard self.session === session else { return }
        interrupted = false
        publishTrackingState("initializing")
    }

    public func session(_ session: ARSession, didFailWithError error: Error) {
        guard self.session === session else { return }
        stopOwnedSession()
        publishTrackingState("unavailable")
    }

    /// ARKit camera space is fixed to the device's landscape sensor axis; this
    /// roll about the camera's view axis realigns it with the current
    /// interface orientation so +Y is "up on screen".
    private static func interfaceOrientationCorrection(_ orientation: UIInterfaceOrientation) -> simd_quatf {
        let angle: Float
        switch orientation {
        case .portrait:
            angle = .pi / 2
        case .portraitUpsideDown:
            angle = -.pi / 2
        case .landscapeLeft:
            angle = .pi
        default:
            angle = 0
        }
        return simd_quatf(angle: angle, axis: SIMD3<Float>(0, 0, 1))
    }
}
