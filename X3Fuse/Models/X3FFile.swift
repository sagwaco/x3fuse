//
//  X3FFile.swift
//  X3Fuse
//
//  Created by Sang Lee on 7/8/25.
//

import Foundation
import SwiftUI

enum ConversionStatus {
  case queued
  case processing
  case completed
  case failed
  case warning
}

enum OutputFormat: Int, CaseIterable {
  case dng = 0
  case embeddedJpg = 1
  case tiff = 2

  var displayName: String {
    switch self {
    case .dng: return "DNG (default)"
    case .embeddedJpg: return "Embedded JPG"
    case .tiff: return "TIFF"
    }
  }

  var fileExtension: String {
    switch self {
    case .dng: return ".dng"
    case .embeddedJpg: return ".jpg"
    case .tiff: return ".tif"
    }
  }
}

enum ColorProfile: Int, CaseIterable {
  case sRGB = 0
  case adobeRGB = 1
  case proPhotoRGB = 2
  case none = 3

  var displayName: String {
    switch self {
    case .sRGB: return "sRGB (default)"
    case .adobeRGB: return "AdobeRGB"
    case .proPhotoRGB: return "ProPhotoRGB"
    case .none: return "None"
    }
  }

  var x3fArgument: String? {
    switch self {
    case .sRGB: return nil  // default
    case .adobeRGB: return "AdobeRGB"
    case .proPhotoRGB: return "ProPhotoRGB"
    case .none: return "None"
    }
  }
}

@Observable
class X3FFile: NSObject, Identifiable {
  let id = UUID()
  let url: URL
  let fileName: String
  var status: ConversionStatus = .queued
  var progress: Double = 0.0
  var errorMessage: String?
  var warningMessage: String?

  // EXIF metadata
  var cameraModel: String?
  var lensId: String?
  var aperture: String?
  var capturedDate: Date?
  var fileSize: Int64?
  var exifData: [String: Any] = [:]

  // Conversion settings override (if different from global settings)
  var outputFormat: OutputFormat?
  var compress: Bool?
  var denoise: Bool?
  var fasterProcessing: Bool?
  var colorProfile: ColorProfile?

  init(url: URL) {
    self.url = url
    self.fileName = url.lastPathComponent
  }

  var displayStatus: String {
    switch status {
    case .queued: return "Queued"
    case .processing: return "Processing..."
    case .completed: return "Completed"
    case .failed: return "Failed"
    case .warning: return "Warning"
    }
  }

  var statusColor: Color {
    switch status {
    case .queued: return .secondary
    case .processing: return .blue
    case .completed: return .green
    case .failed: return .red
    case .warning: return .orange
    }
  }

  var statusIcon: String {
    switch status {
    case .queued: return "document.badge.ellipsis"
    case .processing: return "circle.dotted.circle"
    case .completed: return "checkmark.circle.fill"
    case .failed: return "exclamationmark.triangle.fill"
    case .warning: return "checkmark.circle.trianglebadge.exclamationmark"
    }
  }

  var statusIconColor: Color {
    switch status {
    case .queued: return .primary
    case .processing: return .blue
    case .completed: return .green
    case .failed: return .red
    case .warning: return .orange
    }
  }

  var outputFileName: String {
    let baseName = url.deletingPathExtension().lastPathComponent
    let format = outputFormat ?? .dng
    return baseName + format.fileExtension
  }

  var outputFilePath: String {
    let baseName = url.deletingPathExtension().lastPathComponent
    let format = outputFormat ?? ConversionSettings.shared.outputFormat
    let effectiveOutputDirectory = ConversionSettings.shared.effectiveOutputDirectory(for: url)
    let outputDirectoryURL = URL(fileURLWithPath: effectiveOutputDirectory)
    return outputDirectoryURL.appendingPathComponent(baseName + format.fileExtension).path
  }

  var outputFileExists: Bool {
    return FileManager.default.fileExists(atPath: outputFilePath)
  }

  func resetForReconversion() {
    status = .queued
    progress = 0.0
    errorMessage = nil
    warningMessage = nil
  }

  // MARK: - Computed properties for sorting

  var sortableCameraModel: String {
    return cameraModel ?? ""
  }

  var sortableAperture: String {
    return aperture ?? ""
  }

  var sortableCapturedDate: Date {
    return capturedDate ?? Date.distantPast
  }

  var sortableFileSize: Int64 {
    return fileSize ?? 0
  }

  // MARK: - NSObject overrides

  override var hash: Int {
    return id.hashValue
  }

  override func isEqual(_ object: Any?) -> Bool {
    guard let other = object as? X3FFile else { return false }
    return self.id == other.id
  }
}
