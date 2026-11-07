// pdfpages: what the PDF reader asks of PDFKit (plan lector-md D4). Compiled on first
// use by pdf-view.js with `/usr/bin/swiftc -O` into
// <appHome>/data/code-file/bin/pdfpages-<hash of this file>, so editing it compiles
// a new one. Herdr's exec is text-only (30 s, 8 MiB): pages go to PNG files and
// every answer is one JSON line on stdout.
//
//   pdfpages version
//   pdfpages info <pdf>
//     {"pages":N,"sizes":[[w,h],...]}            page sizes in points, as shown:
//                                                 the crop box, the page's rotation applied
//   pdfpages render <pdf> <outdir> <scale> <n,n,...>
//     {"done":[n,...],"failed":[n,...]}          <outdir>/p<n>.png at <scale> px per point
//   pdfpages find <pdf> <query>
//     {"matches":[{"page":n,"rects":[[x,y,w,h],...]}],"capped":false}
//                                                 case and diacritics ignored; rects in points
//                                                 from the shown page's top-left, one per line
//
// Pages are numbered from 1. A failure answers {"error":"usage"|"unreadable"|"locked"}
// and exits 64, 2 or 3.

import AppKit
import Foundation
import PDFKit

let VERSION = "1"
let MAX_MATCHES = 5000

func emit(_ json: String) {
  FileHandle.standardOutput.write((json + "\n").data(using: .utf8)!)
}

func fail(_ error: String, _ code: Int32) -> Never {
  emit("{\"error\":\"\(error)\"}")
  exit(code)
}

// Two decimals: enough for a point, and the JSON stays small.
func num(_ v: CGFloat) -> String {
  let r = (Double(v) * 100).rounded() / 100
  return r == r.rounded() ? String(Int(r)) : String(r)
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage", 64) }
if args[1] == "version" {
  emit("{\"version\":\"\(VERSION)\"}")
  exit(0)
}
guard args.count >= 3 else { fail("usage", 64) }

// An encrypted file with an empty user password opens unlocked; one that needs a
// password stays locked, and nothing in it can be drawn or searched.
guard let doc = PDFDocument(url: URL(fileURLWithPath: args[2])) else { fail("unreadable", 2) }
if doc.isLocked { fail("locked", 3) }
if doc.pageCount == 0 { fail("unreadable", 2) }

// The crop box as the page is shown: a page turned a quarter is as wide as it was tall.
func shownSize(_ page: PDFPage) -> CGSize {
  let b = page.bounds(for: .cropBox)
  let quarter = ((page.rotation % 360) + 360) % 180 == 90
  return quarter ? CGSize(width: b.height, height: b.width) : b.size
}

func info() -> Never {
  var sizes: [String] = []
  sizes.reserveCapacity(doc.pageCount)
  for i in 0..<doc.pageCount {
    guard let page = doc.page(at: i) else { fail("unreadable", 2) }
    let s = shownSize(page)
    sizes.append("[\(num(s.width)),\(num(s.height))]")
  }
  emit("{\"pages\":\(doc.pageCount),\"sizes\":[\(sizes.joined(separator: ","))]}")
  exit(0)
}

// drawWithBox applies the box's origin and the page's rotation itself, so the
// bitmap only needs the shown size. White first: a page has no background of its own.
func renderPage(_ page: PDFPage, scale: CGFloat, to url: URL) -> Bool {
  let s = shownSize(page)
  let w = max(1, Int((s.width * scale).rounded()))
  let h = max(1, Int((s.height * scale).rounded()))
  let space = CGColorSpaceCreateDeviceRGB()
  guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
  ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
  ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  ctx.interpolationQuality = .high
  ctx.scaleBy(x: CGFloat(w) / s.width, y: CGFloat(h) / s.height)
  page.draw(with: .cropBox, to: ctx)
  guard let image = ctx.makeImage() else { return false }
  guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { return false }
  // Atomic: Herdr's image loader never sees half a file.
  do { try data.write(to: url, options: .atomic) } catch { return false }
  return true
}

func render() -> Never {
  guard args.count >= 6, let scale = Double(args[4]), scale > 0, scale <= 64 else { fail("usage", 64) }
  let out = URL(fileURLWithPath: args[3], isDirectory: true)
  do { try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true) } catch { fail("unreadable", 2) }
  var done: [String] = []
  var failed: [String] = []
  for part in args[5].split(separator: ",") {
    // A number that names no page fails alone; what isn't a number is dropped.
    guard let n = Int(part) else { continue }
    guard n >= 1, n <= doc.pageCount, let page = doc.page(at: n - 1) else {
      failed.append(String(n))
      continue
    }
    if autoreleasepool(invoking: { renderPage(page, scale: CGFloat(scale), to: out.appendingPathComponent("p\(n).png")) }) {
      done.append(String(n))
    } else {
      failed.append(String(n))
    }
  }
  emit("{\"done\":[\(done.joined(separator: ","))],\"failed\":[\(failed.joined(separator: ","))]}")
  exit(0)
}

// A rect in page space to the shown page, top-left origin: transform(for:) is the
// same box origin and rotation drawWithBox applies.
func shownRect(_ r: CGRect, on page: PDFPage) -> CGRect {
  let s = shownSize(page)
  let t = r.applying(page.transform(for: .cropBox))
  return CGRect(x: t.minX, y: s.height - t.maxY, width: t.width, height: t.height)
}

func find() -> Never {
  guard args.count >= 4, !args[3].isEmpty else { fail("usage", 64) }
  let found = doc.findString(args[3], withOptions: [.caseInsensitive, .diacriticInsensitive])
  var matches: [String] = []
  for selection in found.prefix(MAX_MATCHES) {
    guard let page = selection.pages.first else { continue }
    let n = doc.index(for: page) + 1
    // A match across a line break is one rect per line; one across pages keeps its first page.
    var rects: [String] = []
    for line in selection.selectionsByLine() where line.pages.first == page {
      let r = shownRect(line.bounds(for: page), on: page)
      if r.isEmpty || r.isNull { continue }
      rects.append("[\(num(r.minX)),\(num(r.minY)),\(num(r.width)),\(num(r.height))]")
    }
    if rects.isEmpty {
      let r = shownRect(selection.bounds(for: page), on: page)
      if r.isEmpty || r.isNull { continue }
      rects.append("[\(num(r.minX)),\(num(r.minY)),\(num(r.width)),\(num(r.height))]")
    }
    matches.append("{\"page\":\(n),\"rects\":[\(rects.joined(separator: ","))]}")
  }
  emit("{\"matches\":[\(matches.joined(separator: ","))],\"capped\":\(found.count > MAX_MATCHES)}")
  exit(0)
}

switch args[1] {
case "info": info()
case "render": render()
case "find": find()
default: fail("usage", 64)
}
