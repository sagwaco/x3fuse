//
//  X3FFileInspector.swift
//  X3Fuse
//
//  Structural sanity check for X3F files, run before handing a file to x3f_extract.
//

import Foundation

/// Cheap structural check of an X3F container.
///
/// An X3F file starts with the `FOVb` signature and ends with a little-endian UInt32 holding
/// the offset of the directory section, which itself starts with `SECd`. A file that was cut
/// short while being copied keeps a valid header, but its last four bytes are image data, so
/// the "directory offset" points past the end of the file or at random bytes. x3f_extract does
/// not detect this: it accepts the header and then spins forever at 100% CPU, stalling the
/// whole queue until the user cancels. Rejecting such files up front keeps the queue moving
/// and gives the user an actionable error instead of a hang.
enum X3FFileInspector {
  enum StructureError: LocalizedError, Equatable {
    case tooSmall(size: UInt64)
    case badSignature
    case directoryOffsetOutOfRange(offset: UInt32, size: UInt64)
    case badDirectorySignature(offset: UInt32)

    var errorDescription: String? {
      switch self {
      case .tooSmall(let size):
        return "File is too small to be an X3F image (\(size) bytes)."
      case .badSignature:
        return "File does not start with the X3F signature."
      case .directoryOffsetOutOfRange(let offset, let size):
        return
          "File appears to be truncated: the directory offset (\(offset)) is beyond the end of the file (\(size) bytes). Re-copy it from the camera or the original source."
      case .badDirectorySignature(let offset):
        return
          "File appears to be truncated or corrupt: no directory section at offset \(offset). Re-copy it from the camera or the original source."
      }
    }
  }

  static let signature = Data("FOVb".utf8)
  static let directorySignature = Data("SECd".utf8)

  /// 16-byte file header + 12-byte directory header + 4-byte trailing directory offset.
  static let minimumSize: UInt64 = 32
  private static let directoryHeaderSize: UInt64 = 12
  private static let trailerSize: UInt64 = 4

  /// Throws a `StructureError` if the file cannot be a complete X3F container.
  /// I/O errors (unreadable file, permissions) are rethrown as-is.
  static func validateStructure(at url: URL) throws {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }

    let size = try handle.seekToEnd()
    guard size >= minimumSize else {
      throw StructureError.tooSmall(size: size)
    }

    try handle.seek(toOffset: 0)
    guard let head = try handle.read(upToCount: signature.count), head == signature else {
      throw StructureError.badSignature
    }

    try handle.seek(toOffset: size - trailerSize)
    guard let trailer = try handle.read(upToCount: Int(trailerSize)),
      trailer.count == Int(trailerSize)
    else {
      throw StructureError.tooSmall(size: size)
    }
    let rawOffset = trailer.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
    let directoryOffset = UInt32(littleEndian: rawOffset)

    // The directory must fit between the file header and the trailing offset.
    let directoryEnd = UInt64(directoryOffset) + directoryHeaderSize
    guard directoryOffset >= 16, directoryEnd <= size - trailerSize else {
      throw StructureError.directoryOffsetOutOfRange(offset: directoryOffset, size: size)
    }

    try handle.seek(toOffset: UInt64(directoryOffset))
    guard let dir = try handle.read(upToCount: directorySignature.count),
      dir == directorySignature
    else {
      throw StructureError.badDirectorySignature(offset: directoryOffset)
    }
  }
}
