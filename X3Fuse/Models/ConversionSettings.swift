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
  var compress: Bool = true
  var denoise: Bool = true
  var fasterProcessing: Bool = false  // OpenCL acceleration
  var colorProfile: ColorProfile = .sRGB
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

    // Denoise setting (default is enabled, so add -no-denoise if disabled)
    if !denoise {
      args.append("-no-denoise")
    }

    args.append("-sgain")

    // Compression (only for DNG and TIFF)
    if compress && (outputFormat == .dng || outputFormat == .tiff) {
      args.append("-compress")
    }

    // OpenCL acceleration
    if fasterProcessing {
      args.append("-ocl")
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
    compress = defaults.object(forKey: "compress") as? Bool ?? true
    denoise = defaults.object(forKey: "denoise") as? Bool ?? true
    fasterProcessing = defaults.bool(forKey: "fasterProcessing")
    colorProfile = ColorProfile(rawValue: defaults.integer(forKey: "colorProfile")) ?? .sRGB
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
    defaults.set(denoise, forKey: "denoise")
    defaults.set(fasterProcessing, forKey: "fasterProcessing")
    defaults.set(colorProfile.rawValue, forKey: "colorProfile")
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
