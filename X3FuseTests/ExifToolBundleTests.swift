import AppKit
import Testing

@testable import X3Fuse

struct ExifToolBundleTests {
  @Test func bundledExifToolReadsAndCopiesMetadata() async throws {
    let resources = try #require(Bundle.main.resourceURL)
    #expect(
      FileManager.default.fileExists(
        atPath: resources.appendingPathComponent("lib/Image/ExifTool.pm").path))
    let service = ExifService.shared
    let version = try await service.runExifTool(arguments: ["-config", "", "-ver"])
    #expect(version.trimmingCharacters(in: .whitespacesAndNewlines) == "13.33")

    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }

    let image = try #require(
      NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: 1, pixelsHigh: 1, bitsPerSample: 8,
        samplesPerPixel: 3, hasAlpha: false, isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0))
    image.setColor(.white, atX: 0, y: 0)
    let tiff = try #require(image.representation(using: .tiff, properties: [:]))
    let source = directory.appendingPathComponent("source image.tiff")
    let destination = directory.appendingPathComponent("destination image.tiff")
    try tiff.write(to: source)
    try tiff.write(to: destination)

    _ = try await service.runExifTool(arguments: [
      "-config", "", "-overwrite_original", "-Model=SIGMA DP2 Merrill", "-FNumber=5.6",
      source.path,
    ])
    try await service.copyExifData(from: source, to: destination)
    let metadata = try await service.extractMetadataWithExifTool(from: destination)
    #expect(metadata["Model"] as? String == "SIGMA DP2 Merrill")
    #expect(metadata["Aperture"] as? Double == 5.6)
  }
}
