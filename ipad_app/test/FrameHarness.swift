import Foundation
import CoreMedia
import CoreVideo
import ImageIO

@main struct FrameHarness {
    // Build raw ReplayKit-style buffers from a known upright four-color image.
    // Coordinate formulas describe source pixels independently of Core Image.
    static func sample(_ orientation: CGImagePropertyOrientation) -> CMSampleBuffer {
        let uprightWidth = 2560, uprightHeight = 1280
        let landscape = orientation == .left || orientation == .right
        let width = landscape ? uprightHeight : uprightWidth
        let height = landscape ? uprightWidth : uprightHeight
        var buffer: CVPixelBuffer?
        precondition(CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA,
            [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &buffer) == kCVReturnSuccess)
        let pixel = buffer!
        CVPixelBufferLockBaseAddress(pixel, [])
        let bytes = CVPixelBufferGetBaseAddress(pixel)!.assumingMemoryBound(to: UInt8.self)
        let stride = CVPixelBufferGetBytesPerRow(pixel)
        for y in 0..<height {
            for x in 0..<width {
                let sourceX: Int, sourceY: Int
                switch orientation {
                case .left: (sourceX, sourceY) = (uprightWidth - 1 - y, x)
                case .right: (sourceX, sourceY) = (y, uprightHeight - 1 - x)
                case .down: (sourceX, sourceY) = (uprightWidth - 1 - x, uprightHeight - 1 - y)
                default: (sourceX, sourceY) = (x, y)
                }
                let left = sourceX < uprightWidth / 2, top = sourceY < uprightHeight / 2
                let i = y * stride + x * 4
                // Red, green, blue, yellow: every rotation has different corners.
                bytes[i] = !top && left ? 255 : 0
                bytes[i + 1] = !left ? 255 : 0
                bytes[i + 2] = (top && left) || (!top && !left) ? 255 : 0
                bytes[i + 3] = 255
            }
        }
        CVPixelBufferUnlockBaseAddress(pixel, [])
        var description: CMVideoFormatDescription?
        precondition(CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: pixel,
            formatDescriptionOut: &description) == noErr)
        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: .zero, decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        precondition(CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: pixel,
            formatDescription: description!, sampleTiming: &timing, sampleBufferOut: &sample) == noErr)
        return sample!
    }

    static func corners(_ image: CGImage) -> [UInt8] {
        var pixels = [UInt8](repeating: 0, count: image.width * image.height * 4)
        return pixels.withUnsafeMutableBytes { raw in
            let context = CGContext(data: raw.baseAddress, width: image.width, height: image.height,
                bitsPerComponent: 8, bytesPerRow: image.width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            let bytes = raw.bindMemory(to: UInt8.self)
            return [(1, 1), (3, 1), (1, 3), (3, 3)].flatMap { x, y in
                let offset = ((image.height * y / 4) * image.width + image.width * x / 4) * 4
                return Array(bytes[offset..<(offset + 3)])
            }
        }
    }

    static func main() async throws {
        let capture = FrameCapture()
        capture.setEnabled(true)
        var uprightCorners: [UInt8] = []
        for orientation in [CGImagePropertyOrientation.up, .right, .down, .left] {
            let frame = sample(orientation)
            let request = Task { try await capture.request() }
            try await Task.sleep(for: .milliseconds(30))
            capture.consume(frame, orientation: orientation)
            let shot = try await request.value
            precondition(shot.width == 1280 && shot.height == 640)
            let source = CGImageSourceCreateWithData(shot.jpeg as CFData, nil)!
            let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
            precondition(image.width == shot.width && image.height == shot.height)
            precondition(shot.jpeg.count > 1000)
            let colors = corners(image)
            if orientation == .up { uprightCorners = colors }
            precondition(zip(colors, uprightCorners).allSatisfy { abs(Int($0) - Int($1)) <= 3 },
                "ReplayKit orientation \(orientation.rawValue) did not restore upright pixels")
            try shot.jpeg.write(to: URL(fileURLWithPath: "build/frame-test-\(orientation.rawValue).jpg"))
        }
        let cancelled = Task { try await capture.request() }
        try await Task.sleep(for: .milliseconds(20)); cancelled.cancel()
        do { _ = try await cancelled.value; preconditionFailure("Expected cancellation") } catch {}
        let paused = Task { try await capture.request() }
        try await Task.sleep(for: .milliseconds(20)); capture.setEnabled(false)
        do { _ = try await paused.value; preconditionFailure("Expected pause failure") } catch {}
        print("Real frame encoding, scaling, orientation, cancellation, and pause tests passed.")
    }
}
