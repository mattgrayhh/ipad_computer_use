import AppKit

// Synthetic portrait/landscape-independent fixture; no user screen is captured.
let image = NSImage(size: NSSize(width: 800, height: 600))
image.lockFocus()
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: 800, height: 600).fill()
let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 36), .foregroundColor: NSColor.black]
("Settings" as NSString).draw(at: NSPoint(x: 40, y: 480), withAttributes: attributes)
("Privacy" as NSString).draw(at: NSPoint(x: 40, y: 280), withAttributes: attributes)
image.unlockFocus()
let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
FileHandle.standardOutput.write(bitmap.representation(using: .jpeg, properties: [:])!)
