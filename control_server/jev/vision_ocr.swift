import Foundation
import Vision
import ImageIO
import AppKit

// Reads an iPad screenshot from stdin. Never captures or controls the host Mac.
struct Bounds: Encodable { let x: Double; let y: Double; let width: Double; let height: Double }
struct Item: Encodable { let text: String; let bounds: Bounds }
struct Observation: Encodable { let width: Int; let height: Int; let items: [Item] }

func recognize(_ data: Data) throws -> Data {
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
        let x = max(0, b.minX * w), y = max(0, (1 - b.maxY) * h)
        return Item(text: candidate.string, bounds: Bounds(x: x, y: y,
            width: min(w - x, b.width * w), height: min(h - y, b.height * h)))
    }
    return try JSONEncoder().encode(Observation(width: image.width, height: image.height, items: items))
}

func readExactly(_ count: Int) -> Data? {
    var data = Data()
    while data.count < count {
        let part = FileHandle.standardInput.readData(ofLength: count - data.count)
        if part.isEmpty { return nil }
        data.append(part)
    }
    return data
}

do {
    if CommandLine.arguments.contains("--serve") {
        // Length-prefixed JPEG input and one JSON line per response. Keep Vision warm.
        while let header = readExactly(4) {
            let length = header.reduce(0) { ($0 << 8) | Int($1) }
            guard length > 0, length <= 2 * 1024 * 1024, let data = readExactly(length) else {
                throw NSError(domain: "JevOCR", code: 2)
            }
            try autoreleasepool {
                FileHandle.standardOutput.write(try recognize(data))
                FileHandle.standardOutput.write(Data([10]))
            }
        }
        exit(0)
    }
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
    FileHandle.standardOutput.write(try recognize(data))
} catch {
    FileHandle.standardError.write(Data("OCR failed: \(error.localizedDescription)\n".utf8))
    exit(1)
}
