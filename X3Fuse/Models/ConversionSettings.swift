//
//  ConversionSettings.swift
//  X3Fuse
//
//  Created by Sang Lee on 7/8/25.
//

import Foundation

@Observable
class ConversionSettings {
  static let shared = ConversionSettings()

  // Settings that match the requirements
  var outputFormat: OutputFormat = .dng
  var compress: Bool = false
  var denoiseIntensity: Int = 10  // OpenCV NLM denoise intensity, 0 = off ... 10 = full strength
  var colorProfile: ColorProfile = .sRGB
  var dngHighlightRecovery: Bool = false  // Merrill-generation DNG highlight recovery (-dng-highlight-recovery)
  var cineon: Bool = false  // Cineon-style flat tone curve for TIFF (-cineon)
  var outputDirectory: String? = nil  // nil = use input file directory, string = custom path
  var debugLoggingEnabled: Bool = false
  var onlyProcessNewItems: Bool = true  // Only process files that are queued, not already converted

  // Sort preferences
  var sortField: String = "File Name"  // Store as string for persistence
  var sortAscending: Bool = true

  private init() {
    loadSettings()
  }

  // Build x3f_extract arguments based on current settings
  func buildX3FArguments() -> [String] {
    var args: [String] = []

    // Denoise intensity (default is 10/full strength, so only pass when it differs)
    if denoiseIntensity != 10 {
      args.append("-denoise")
      args.append(String(denoiseIntensity))
    }

    args.append("-sgain")

    // Compression (only for DNG and TIFF)
    if compress && (outputFormat == .dng || outputFormat == .tiff) {
      args.append("-compress")
    }

    // Output format
    switch outputFormat {
    case .dng:
      // Default, no additional argument needed
      break
    case .embeddedJpg:
      args.append("-jpg")
    case .tiff:
      args.append("-tiff")
    }

    // Merrill-generation DNG highlight recovery (DNG only)
    if dngHighlightRecovery && outputFormat == .dng {
      args.append("-dng-highlight-recovery")
    }

    // Cineon-style flat tone curve (TIFF only)
    if cineon && outputFormat == .tiff {
      args.append("-cineon")
    }

    // Color profile
    if let colorArg = colorProfile.x3fArgument {
      args.append("-color")
      args.append(colorArg)
    }

    return args
  }

  // Persistence
  private func loadSettings() {
    let defaults = UserDefaults.standard

    outputFormat = OutputFormat(rawValue: defaults.integer(forKey: "outputFormat")) ?? .dng
    compress = defaults.object(forKey: "compress") as? Bool ?? false
    if defaults.object(forKey: "denoiseIntensity") != nil {
      denoiseIntensity = defaults.integer(forKey: "denoiseIntensity")
    } else if let legacyDenoise = defaults.object(forKey: "denoise") as? Bool {
      // Migrate the old on/off toggle: enabled -> full strength, disabled -> off
      denoiseIntensity = legacyDenoise ? 10 : 0
    } else {
      denoiseIntensity = 10
    }
    denoiseIntensity = min(max(denoiseIntensity, 0), 10)
    colorProfile = ColorProfile(rawValue: defaults.integer(forKey: "colorProfile")) ?? .sRGB
    dngHighlightRecovery = defaults.bool(forKey: "dngHighlightRecovery")
    cineon = defaults.bool(forKey: "cineon")
    outputDirectory = defaults.string(forKey: "outputDirectory")
    debugLoggingEnabled = defaults.bool(forKey: "debugLoggingEnabled")
    onlyProcessNewItems = defaults.object(forKey: "onlyProcessNewItems") as? Bool ?? true
    sortField = defaults.string(forKey: "sortField") ?? "File Name"
    sortAscending = defaults.object(forKey: "sortAscending") as? Bool ?? true
  }

  func saveSettings() {
    let defaults = UserDefaults.standard

    defaults.set(outputFormat.rawValue, forKey: "outputFormat")
    defaults.set(compress, forKey: "compress")
    defaults.set(denoiseIntensity, forKey: "denoiseIntensity")
    defaults.set(colorProfile.rawValue, forKey: "colorProfile")
    defaults.set(dngHighlightRecovery, forKey: "dngHighlightRecovery")
    defaults.set(cineon, forKey: "cineon")
    defaults.set(outputDirectory, forKey: "outputDirectory")
    defaults.set(debugLoggingEnabled, forKey: "debugLoggingEnabled")
    defaults.set(onlyProcessNewItems, forKey: "onlyProcessNewItems")
    defaults.set(sortField, forKey: "sortField")
    defaults.set(sortAscending, forKey: "sortAscending")
  }

  // Helper to determine if compression option should be shown
  var shouldShowCompressionOption: Bool {
    return outputFormat == .dng || outputFormat == .tiff
  }

  // Helper to determine if color profile should be shown
  var shouldShowColorProfileOption: Bool {
    return outputFormat == .embeddedJpg || outputFormat == .tiff
  }

  // Helper to determine if the DNG highlight recovery option should be shown
  var shouldShowDngHighlightRecoveryOption: Bool {
    return outputFormat == .dng
  }

  // Helper to determine if the Cineon tone curve option should be shown
  var shouldShowCineonOption: Bool {
    return outputFormat == .tiff
  }

  // Output directory helpers
  func effectiveOutputDirectory(for inputURL: URL) -> String {
    return outputDirectory ?? inputURL.deletingLastPathComponent().path
  }

  func isOutputDirectoryValid() -> Bool {
    guard let directory = outputDirectory else { return true }  // nil is valid (use input directory)

    let fileManager = FileManager.default
    var isDirectory: ObjCBool = false

    // Check if directory exists and is actually a directory
    guard fileManager.fileExists(atPath: directory, isDirectory: &isDirectory),
      isDirectory.boolValue
    else {
      return false
    }

    // Check if directory is writable
    return fileManager.isWritableFile(atPath: directory)
  }

  var outputDirectoryDisplayName: String {
    if let directory = outputDirectory {
      return directory
    } else {
      return "Same as input files"
    }
  }

  func resetOutputDirectory() {
    outputDirectory = nil
  }

  // Computed property for the toggle
  var outputToSameDirectory: Bool {
    get {
      return outputDirectory == nil
    }
    set {
      if newValue {
        outputDirectory = nil
      } else if outputDirectory == nil {
        // If switching from same directory to custom, but no custom directory is set,
        // we'll let the UI handle prompting for directory selection
        // For now, just ensure it's not nil by setting to Documents directory
        outputDirectory =
          FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?.path
      }
    }
  }
}
