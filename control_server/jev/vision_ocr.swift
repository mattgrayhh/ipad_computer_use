import Foundation
import Vision
import ImageIO
import AppKit

// Reads an iPad screenshot from stdin. Never captures or controls the host Mac.
struct Bounds: Encodable { let x: Double; let y: Double; let width: Double; let height: Double }
struct Item: Encodable { let text: String; let bounds: Bounds }
struct Observation: Encodable { let width: Int; let height: Int; let items: [Item] }

do {
    let data: Data
    if CommandLine.arguments.contains("--warmup") {
        // Trigger Apple's one-time model initialization before a timed MCP request.
        let fixture = NSImage(size: NSSize(width: 1280, height: 960))
        fixture.lockFocus()
        NSColor.white.setFill()
        NSRect(x: 0, y: 0, width: 1280, height: 960).fill()
        ("Jev OCR ready" as NSString).draw(at: NSPoint(x: 40, y: 800), withAttributes: [
            .font: NSFont.systemFont(ofSize: 36), .foregroundColor: NSColor.black
        ])
        fixture.unlockFocus()
        data = NSBitmapImageRep(data: fixture.tiffRepresentation!)!.representation(using: .jpeg, properties: [:])!
    } else {
        data = FileHandle.standardInput.readDataToEndOfFile()
    }
    guard data.count <= 2 * 1024 * 1024,
          let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw NSError(domain: "JevOCR", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid screenshot"])
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: image, orientation: .up).perform([request])
    let w = Double(image.width), h = Double(image.height)
    let items = (request.results ?? []).compactMap { observation -> Item? in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let b = observation.boundingBox
        // Vision is normalized bottom-left; control API uses screenshot pixels, top-left.
        let x = max(0, b.minX * w), y = max(0, (1 - b.maxY) * h)
        return Item(text: candidate.string, bounds: Bounds(x: x, y: y,
            width: min(w - x, b.width * w), height: min(h - y, b.height * h)))
    }
    let output = try JSONEncoder().encode(Observation(width: image.width, height: image.height, items: items))
    FileHandle.standardOutput.write(output)
} catch {
    FileHandle.standardError.write(Data("OCR failed: \(error.localizedDescription)\n".utf8))
    exit(1)
}
