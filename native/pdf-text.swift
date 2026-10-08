// Prints the text of a PDF (stdin) using macOS PDFKit. Resumes exported from Chrome, Word or Pages
// embed CID fonts whose glyphs the server's own BT/ET reader cannot map back to characters (it read
// font bytes as text); PDFKit applies the ToUnicode maps. The app server uses it when present.
//   swiftc -O native/pdf-text.swift -o bin/pdf-text && bin/pdf-text < resume.pdf
import Foundation
import PDFKit

let data = FileHandle.standardInput.readDataToEndOfFile()
guard let document = PDFDocument(data: data) else {
  FileHandle.standardError.write("pdf-text: not a PDF\n".data(using: .utf8)!)
  exit(1)
}
print(document.string ?? "")
