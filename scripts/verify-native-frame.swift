import Foundation
import Vision

// Read-only OCR of a simulator screenshot. Exit zero means OCR ran; `ready`
// reports whether the expected app content is actually visible.
let arguments = CommandLine.arguments
if arguments.count != 2 {
    FileHandle.standardError.write(Data("Usage: verify-native-frame screenshot.png\n".utf8))
    exit(1)
}
do {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["en-US"]
    request.usesLanguageCorrection = false
    let handler = VNImageRequestHandler(url: URL(fileURLWithPath: arguments[1]), options: [:])
    try handler.perform([request])
    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    let normalized = lines.joined(separator: " ").lowercased().filter { $0.isLetter }
    let brand = normalized.contains("oculo")
    let action = normalized.contains("startexploring")
    let result: [String: Any] = ["ready": brand && action, "brandVisible": brand, "primaryActionVisible": action, "recognizedText": lines]
    let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    FileHandle.standardError.write(Data("Screenshot recognition failed: \(error.localizedDescription)\n".utf8))
    exit(1)
}
