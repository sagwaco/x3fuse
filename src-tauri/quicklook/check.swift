import Foundation

// Self-check for embeddedJPEG. Build it with X3F.swift and -parse-as-library.
// Arguments are real X3F or X3I files: the check prints the JPEG size of each.
@main enum Check {
    static func u32(_ value: Int) -> Data { withUnsafeBytes(of: UInt32(value).littleEndian) { Data($0) } }

    // Makes an X3F file with one small and one large JPEG section and one bad entry.
    static func x3f(_ jpeg: Data) -> Data {
        func section(_ payload: Data) -> Data {
            Data("SECi".utf8) + u32(0) + u32(2) + u32(18) + Data(count: 12) + payload
        }
        let small = section(Data([1, 2, 3])), large = section(jpeg)
        var file = Data("FOVb".utf8) + Data(count: 12)
        let smallOffset = file.count; file += small
        let largeOffset = file.count; file += large
        let directory = file.count
        file += Data("SECd".utf8) + u32(0) + u32(3)
        file += u32(smallOffset) + u32(small.count) + Data("IMA2".utf8)
        file += u32(1 << 30) + u32(100) + Data("IMA2".utf8)
        file += u32(largeOffset) + u32(large.count) + Data("IMA2".utf8)
        return file + u32(directory)
    }

    static func main() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let jpeg = Data((0 ..< 1000).map { UInt8($0 % 251) })
        let frame = x3f(jpeg)

        let x3fURL = dir.appendingPathComponent("a.x3f")
        try frame.write(to: x3fURL)
        precondition(try! embeddedJPEG(at: x3fURL) == jpeg, "X3F JPEG")

        // X3I: a padding frame of another kind first, then two frames.
        var x3i = Data("FOVi".utf8) + Data(count: 28)
        let first = x3i.count; x3i += frame
        let other = x3f(Data([9, 9, 9, 9]))
        let second = x3i.count; x3i += other
        let directory = x3i.count
        x3i += Data("SECf".utf8) + u32(0) + u32(3)
        x3i += u32(4) + u32(8) + Data("HEAD".utf8)
        x3i += u32(first) + u32(frame.count) + Data("FRAM".utf8)
        x3i += u32(second) + u32(other.count) + Data("FRAM".utf8)
        x3i += u32(directory)
        let x3iURL = dir.appendingPathComponent("a.x3i")
        try x3i.write(to: x3iURL)
        precondition(try! embeddedJPEG(at: x3iURL) == jpeg, "X3I frame 0 JPEG")

        for bad in [Data(), Data("FOVb".utf8), frame.dropLast(), Data("FOVi".utf8) + u32(0) + u32(4)] {
            let url = dir.appendingPathComponent("bad")
            try Data(bad).write(to: url)
            precondition((try? embeddedJPEG(at: url)) == nil, "bad file throws")
        }

        for path in CommandLine.arguments.dropFirst() {
            let data = try embeddedJPEG(at: URL(fileURLWithPath: path))
            precondition(data.starts(with: [0xFF, 0xD8]), "JPEG marker in \(path)")
            print("\(path): \(data.count) bytes")
        }
        print("check passed")
    }
}
