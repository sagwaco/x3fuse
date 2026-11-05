import Foundation

/// Returns the largest JPEG preview that is embedded in an X3F file, or in
/// the first frame of an X3I file.
///
/// An X3F file starts with "FOVb". Its last 4 bytes give the offset of the
/// "SECd" directory. Each 12-byte directory entry has an offset, a length, and
/// a tag. An image section starts with "SECi" and a 28-byte header. Type 2
/// with format 18 is a JPEG.
///
/// An X3I file starts with "FOVi". Its last 4 bytes give the offset of the
/// "SECf" directory. Each "FRAM" entry is a complete X3F file.
func embeddedJPEG(at url: URL) throws -> Data {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    let corrupt = CocoaError(.fileReadCorruptFile, userInfo: [NSURLErrorKey: url])
    // All offsets are relative to `base`. The X3F data has `size` bytes.
    var base = 0
    var size = Int(try handle.seekToEnd())

    func bytes(_ offset: Int, _ count: Int) throws -> Data {
        guard offset >= 0, count > 0, offset <= size - count else { throw corrupt }
        try handle.seek(toOffset: UInt64(base + offset))
        guard let data = try handle.read(upToCount: count), data.count == count else { throw corrupt }
        return data
    }
    func u32(_ data: Data, _ offset: Int) -> Int {
        data.withUnsafeBytes { Int(UInt32(littleEndian: $0.loadUnaligned(fromByteOffset: offset, as: UInt32.self))) }
    }
    // Reads a directory with the given magic. Real files have fewer than 10
    // entries. The limit makes a bad count fail fast.
    func directory(_ magic: String) throws -> Data {
        let offset = u32(try bytes(size - 4, 4), 0)
        let header = try bytes(offset, 12)
        let count = u32(header, 8)
        guard header.prefix(4) == Data(magic.utf8), count <= 1 << 16 else { throw corrupt }
        return count == 0 ? Data() : try bytes(offset + 12, count * 12)
    }

    if try bytes(0, 4) == Data("FOVi".utf8) {
        // ponytail: frame 0 is the SFD reference exposure, which is also the
        // median exposure in the sample. Use the median EXIF exposure if a
        // sample disagrees.
        let entries = try directory("SECf")
        guard let entry = stride(from: 0, to: entries.count, by: 12).first(where: {
            entries[$0 + 8 ..< $0 + 12] == Data("FRAM".utf8)
        }) else { throw corrupt }
        let offset = u32(entries, entry), length = u32(entries, entry + 4)
        guard length > 0, offset <= size - length else { throw corrupt }
        base = offset
        size = length
    }

    guard try bytes(0, 4) == Data("FOVb".utf8) else { throw corrupt }
    let entries = try directory("SECd")
    var best: (offset: Int, length: Int)?
    for entry in stride(from: 0, to: entries.count, by: 12) {
        let offset = u32(entries, entry), length = u32(entries, entry + 4)
        // Skip bad entries, so that one bad entry does not hide a good JPEG.
        // Real previews are about 10 MB. The 128 MB limit stops huge allocations.
        guard length > 28, length <= 1 << 27, length > best?.length ?? 0, offset <= size - length,
              let section = try? bytes(offset, 16), section.prefix(4) == Data("SECi".utf8),
              u32(section, 8) == 2, u32(section, 12) == 18 else { continue }
        best = (offset, length)
    }
    guard let best else { throw CocoaError(.fileReadUnknown, userInfo: [NSURLErrorKey: url]) }
    return try bytes(best.offset + 28, best.length - 28)
}
