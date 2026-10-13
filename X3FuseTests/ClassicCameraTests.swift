import Foundation
import Testing

@testable import X3Fuse

struct ClassicCameraTests {
  @Test(arguments: ["SD9", "SD10", "SD14"])
  func readsClassicPropertyMetadata(model: String) async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("\(model).X3F")
    try classicX3F(model: model).write(to: url)

    let file = X3FFile(url: url)
    try FileValidator.shared.validateInputFile(for: file)
    try await ExifService.shared.extractExifData(from: file)
    #expect(file.cameraModel == "SIGMA \(model)")
    #expect(file.aperture == "5.6")
    #expect(file.lensId == nil)
    #expect(ExifService.shared.validateExifData(for: file).isEmpty)

    var truncated = try Data(contentsOf: url)
    truncated.removeLast(8)
    try truncated.write(to: url)
    #expect(throws: (any Error).self) {
      try FileValidator.shared.validateInputFile(for: file)
    }
  }

  @Test func bundledConverterReadsClassicCalibration() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("SD9.X3F")
    try classicX3F(model: "SD9").write(to: url)

    let binary = try #require(BinaryManager.shared.selectX3FBinary(for: X3FFile(url: url)))
    let process = Process()
    process.executableURL = URL(fileURLWithPath: binary)
    process.arguments = ["-meta", "-o", directory.path, url.path]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    #expect(process.terminationStatus == 0)
    let metadata = try String(contentsOf: url.appendingPathExtension("meta"), encoding: .utf8)
    #expect(metadata.contains("BEGIN: CAMF text meta data (name)\n\"text\""))
  }

  @Test func failedExtractionDoesNotInventMerrillMetadata() async throws {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString).appendingPathComponent("SD10.X3F")
    let file = X3FFile(url: url)
    try await ExifService.shared.extractExifData(from: file)
    #expect(file.cameraModel == nil)
    #expect(file.aperture == nil)
    #expect(file.lensId == nil)
    #expect(file.exifData.isEmpty)
  }

  @Test(arguments: ["SIGMA SD1", "SIGMA SD1 Merrill"])
  func sd1StillNeedsLensMetadata(model: String) {
    let file = X3FFile(url: URL(fileURLWithPath: "/tmp/SD1.X3F"))
    file.cameraModel = model
    file.aperture = "5.6"
    #expect(ExifService.shared.validateExifData(for: file) == [
      "Missing lens ID (required for SD1 cameras)"
    ])
  }

  // SD9 and SD10 store camera metadata in a UTF-16 property list without JPEG EXIF.
  private func classicX3F(model: String) -> Data {
    let properties = [("CAMMANUF", "SIGMA"), ("CAMMODEL", "SIGMA \(model)"), ("APERTURE", "5.6")]
    var offsets = Data()
    var strings = Data()
    for (name, value) in properties {
      for string in [name, value] {
        offsets.append(word(UInt32(strings.count / 2)))
        strings.append(string.data(using: .utf16LittleEndian)!)
        strings.append(contentsOf: [0, 0])
      }
    }
    let version: UInt32 = model == "SD9" ? 0x0002_0001 : 0x0002_0002
    var header = Data("FOVb".utf8) + word(version)
    header.append(Data(repeating: 0, count: 224))
    let propertiesHeader = Data("SECp".utf8) + word(0x0002_0000)
      + word(UInt32(properties.count)) + word(0) + word(0) + word(UInt32(strings.count / 2))
    let section = propertiesHeader + offsets + strings

    // Fixed type-2 ciphertext requires 32-bit overflow of the SD9 key.
    let encrypted = Data([
      0x08, 0xac, 0x59, 0x55, 0x94, 0x93, 0xf1, 0x3d, 0xf4, 0xa5, 0x14, 0xe9, 0xbb, 0x53,
      0xb0, 0x9b, 0x2b, 0x0d, 0xf8, 0xeb, 0x8b, 0x34, 0xdb, 0x7e, 0x3e, 0xc9, 0x93, 0x44,
      0x66, 0x44, 0x96, 0xc4, 0xa1, 0xdb,
    ])
    let camf = Data("SECc".utf8) + word(0x0002_0000) + word(2)
      + word(0) + word(0) + word(0) + word(642_884_653) + encrypted
    let camfOffset = UInt32(header.count + section.count)
    let directoryOffset = camfOffset + UInt32(camf.count)
    let directory = Data("SECd".utf8) + word(0x0002_0000) + word(2)
      + word(UInt32(header.count)) + word(UInt32(section.count)) + Data("PROP".utf8)
      + word(camfOffset) + word(UInt32(camf.count)) + Data("CAMF".utf8)
    return header + section + camf + directory + word(directoryOffset)
  }

  private func word(_ value: UInt32) -> Data {
    var littleEndian = value.littleEndian
    return withUnsafeBytes(of: &littleEndian) { Data($0) }
  }
}
