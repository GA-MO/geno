// Builds the Quartz fixtures: swift make.swift <dir>. make.sh runs it after Chrome prints report.pdf.
import AppKit
import PDFKit

let dir = URL(fileURLWithPath: CommandLine.arguments[1])

func drawText(_ text: String, in context: CGContext, at point: CGPoint, size: CGFloat) {
  let attributes: [NSAttributedString.Key: Any] = [.font: NSFont(name: "Helvetica", size: size)!]
  let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes))
  context.textPosition = point
  CTLineDraw(line, context)
}

// quartz.pdf: two text pages drawn by Core Text, as macOS's own "Save as PDF" writes them.
var box = CGRect(x: 0, y: 0, width: 612, height: 792)
let quartz = CGContext(dir.appendingPathComponent("quartz.pdf") as CFURL, mediaBox: &box, nil)!
for (index, lines) in [["Page one says hello.", "Second line here."], ["Page two mentions ZEBRA-7."]].enumerated() {
  quartz.beginPDFPage(nil)
  for (row, line) in lines.enumerated() { drawText(line, in: quartz, at: CGPoint(x: 72, y: 700 - CGFloat(row) * 20), size: 14) }
  if index == 0 { drawText("1", in: quartz, at: CGPoint(x: 300, y: 40), size: 10) }
  quartz.endPDFPage()
}
quartz.closePDF()

// scan.pdf: two pages that are only pictures of text, the way a scanner writes them. Page 1 holds a JPEG, page 2
// raw pixels, which Quartz compresses with Flate.
let pixels = CGContext(data: nil, width: 400, height: 200, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
pixels.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
pixels.fill(CGRect(x: 0, y: 0, width: 400, height: 200))
drawText("SCANNED 913", in: pixels, at: CGPoint(x: 40, y: 80), size: 40)
let raw = pixels.makeImage()!
let jpegData = NSMutableData()
let destination = CGImageDestinationCreateWithData(jpegData, "public.jpeg" as CFString, 1, nil)!
CGImageDestinationAddImage(destination, raw, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
CGImageDestinationFinalize(destination)
let jpeg = CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithData(jpegData, nil)!, 0, nil)!
var scanBox = CGRect(x: 0, y: 0, width: 400, height: 200)
let scan = CGContext(dir.appendingPathComponent("scan.pdf") as CFURL, mediaBox: &scanBox, nil)!
for image in [jpeg, raw] {
  scan.beginPDFPage(nil)
  scan.draw(image, in: scanBox)
  scan.endPDFPage()
}
scan.closePDF()

// encrypted.pdf: report.pdf behind a user password.
let report = PDFDocument(url: dir.appendingPathComponent("report.pdf"))!
report.write(to: dir.appendingPathComponent("encrypted.pdf"), withOptions: [.userPasswordOption: "secret", .ownerPasswordOption: "owner"])
