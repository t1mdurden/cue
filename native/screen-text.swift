// Prints the text on a screenshot (PNG or JPEG on stdin), one screen line per output line, using
// macOS Vision's on-device recognizer. The app server adds it to a local model's turn: at the
// model's 512-token image budget 15 px text is ~7 px and digits blur, while Vision reads the
// full-resolution capture in ~0.4 s without anything leaving the Mac.
//   swiftc -O native/screen-text.swift -o bin/screen-text && bin/screen-text < shot.png
import Foundation
import ImageIO
import Vision

let data = FileHandle.standardInput.readDataToEndOfFile()
guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
  FileHandle.standardError.write("screen-text: not an image\n".data(using: .utf8)!)
  exit(1)
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false   // code and numbers: keep characters exactly as shown
try VNImageRequestHandler(cgImage: image).perform([request])

// Vision returns blocks; a table row or a terminal line comes back as several. Rebuild screen lines:
// boxes whose vertical centres sit within half a line height of each other share a line, left to right.
struct Piece { let text: String; let box: CGRect }
let pieces = (request.results ?? []).compactMap { o in o.topCandidates(1).first.map { Piece(text: $0.string, box: o.boundingBox) } }
var lines: [[Piece]] = []
for piece in pieces.sorted(by: { $0.box.midY > $1.box.midY }) {
  if let last = lines.last?.last, abs(last.box.midY - piece.box.midY) < min(last.box.height, piece.box.height) / 2 {
    lines[lines.count - 1].append(piece)
  } else {
    lines.append([piece])
  }
}
// A wide gap inside a line is a pane boundary (sidebar | editor | terminal): mark it so a label
// and its value stay together while text from different panes reads as separate.
for line in lines {
  var out = ""
  var previous: Piece?
  for piece in line.sorted(by: { $0.box.minX < $1.box.minX }) {
    if let previous { out += piece.box.minX - previous.box.maxX > 0.04 ? "  |  " : " " }
    out += piece.text
    previous = piece
  }
  print(out)
}
