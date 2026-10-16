//
//  ConversionSettings.swift
//  X3Fuse
//
//  Created by Sang Lee on 7/8/25.
//

import Foundation

enum DenoiseAlgorithm: String, CaseIterable {
  case nlm
  case bm3d
}

enum DenoiseBackend: String, CaseIterable {
  case auto
  case cpu
  case gpu
}

/// Camera color mode for -color-mode. The raw value is the x3f_extract argument.
enum CameraColorMode: String, CaseIterable {
  case off
  case asShot = "as-shot"
  case standard = "Standard"
  case vivid = "Vivid"
  case neutral = "Neutral"
  case portrait = "Portrait"
  case landscape = "Landscape"
  case fovClassicBlue = "FCBlue"
  case sunsetRed = "SunsetRed"
  case forestGreen = "ForestGreen"
  case fovClassicYellow = "FCYellow"
  case cinema = "Cinema"
  case tealAndOrange = "TealAndOrange"

  /// Modes that only dp Quattro cameras support.
  static let dpQuattroOnly: [CameraColorMode] = [
    .sunsetRed, .forestGreen, .fovClassicYellow, .cinema, .tealAndOrange,
  ]

  /// Sigma camera labels. DNG profile names use the same labels.
  var displayName: String {
    switch self {
    case .off: return LocalizationService.settingsDenoiseOff
    case .asShot: return LocalizationService.settingsColorModeAsShot
    case .fovClassicBlue: return "FOV Classic Blue"
    case .sunsetRed: return "Sunset Red"
    case .forestGreen: return "Forest Green"
    case .fovClassicYellow: return "FOV Classic Yellow"
    case .tealAndOrange: return "Teal and Orange"
    default: return rawValue
    }
  }

  /// Returns true if x3f_extract can apply this mode to the file.
  /// Other cameras make x3f_extract fail, so they convert without a mode.
  func isSupported(by file: X3FFile) -> Bool {
    if self == .off { return false }
    return file.isDpQuattro || (file.isMerrill && !Self.dpQuattroOnly.contains(self))
  }
}

@Observable
class ConversionSettings {
  static let shared = ConversionSettings()
  private let defaults: UserDefaults

  // Settings that match the requirements
  var outputFormat: OutputFormat = .dng
  var compress: Bool = false
  var denoiseIntensity: Int = 10  // 0 disables denoise; 10 uses full strength.
  var denoiseAlgorithm: DenoiseAlgorithm = .nlm
  var denoiseBackend: DenoiseBackend = .auto
  var denoiseLuminance: Bool = false
  var denoiseChroma: Bool = true
  var denoiseStrength: Double = 1.0
  var nlmLumaPatch: Int = 3
  var nlmChromaPatch: Int = 3
  var nlmLumaSearch: Int = 11
  var nlmChromaSearch: Int = 11
  var colorProfile: ColorProfile = .sRGB
  var dngHighlightRecovery: Bool = false  // Merrill-generation DNG highlight recovery (-dng-highlight-recovery)
  var cineon: Bool = false  // Cineon-style flat tone curve for TIFF (-cineon)
  var colorMode: CameraColorMode = .off  // Camera color mode for TIFF and DNG (-color-mode)
  var sppPipeline: Bool = false  // Merrill SPP processing for TIFF (-spp-pipeline)
  var rgbHighlightRecovery: Bool = true  // Chroma LUT highlight recovery for TIFF (-no-chroma-lut when off)
  var outputDirectory: String? = nil  // nil = use input file directory, string = custom path
  var debugLoggingEnabled: Bool = false
  var onlyProcessNewItems: Bool = true  // Only process files that are queued, not already converted

  // Sort preferences
  var sortField: String = "File Name"  // Store as string for persistence
  var sortAscending: Bool = true

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    loadSettings()
  }

  func buildDenoiseArguments(intensity: Int? = nil) -> [String] {
    let intensity = min(max(intensity ?? denoiseIntensity, 0), 10)
    guard intensity > 0 else { return ["-denoise", "0"] }

    var args = intensity == 10 ? [] : ["-denoise", String(intensity)]
    if denoiseAlgorithm != .nlm {
      args += ["-denoiser", denoiseAlgorithm.rawValue]
    }
    if denoiseBackend != .auto {
      args += ["-denoise-backend", denoiseBackend.rawValue]
    }
    if denoiseLuminance {
      args.append("-denoise-luma")
    }
    if !denoiseChroma {
      args.append("-no-denoise-chroma")
    }
    if denoiseStrength != 1.0 {
      args += ["-denoise-strength", String(denoiseStrength)]
    }
    if denoiseAlgorithm == .nlm {
      for (flag, value, defaultValue) in [
        ("-nlm-luma-patch", nlmLumaPatch, 3),
        ("-nlm-chroma-patch", nlmChromaPatch, 3),
        ("-nlm-luma-search", nlmLumaSearch, 11),
        ("-nlm-chroma-search", nlmChromaSearch, 11),
      ] where value != defaultValue {
        args += [flag, String(value)]
      }
    }
    return args
  }

  // Persistence
  private func loadSettings() {
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
    denoiseAlgorithm =
      DenoiseAlgorithm(rawValue: defaults.string(forKey: "denoiseAlgorithm") ?? "") ?? .nlm
    denoiseBackend =
      DenoiseBackend(rawValue: defaults.string(forKey: "denoiseBackend") ?? "") ?? .auto
    denoiseLuminance = defaults.bool(forKey: "denoiseLuminance")
    denoiseChroma = defaults.object(forKey: "denoiseChroma") as? Bool ?? true
    let strength = defaults.object(forKey: "denoiseStrength") as? Double ?? 1.0
    denoiseStrength = strength.isFinite ? min(max(strength, 0.1), 3.0) : 1.0
    nlmLumaPatch = loadNlmWindow("nlmLumaPatch", defaultValue: 3, maximum: 9)
    nlmChromaPatch = loadNlmWindow("nlmChromaPatch", defaultValue: 3, maximum: 9)
    nlmLumaSearch = loadNlmWindow("nlmLumaSearch", defaultValue: 11, maximum: 31)
    nlmChromaSearch = loadNlmWindow("nlmChromaSearch", defaultValue: 11, maximum: 31)
    colorProfile = ColorProfile(rawValue: defaults.integer(forKey: "colorProfile")) ?? .sRGB
    dngHighlightRecovery = defaults.bool(forKey: "dngHighlightRecovery")
    cineon = defaults.bool(forKey: "cineon")
    colorMode = CameraColorMode(rawValue: defaults.string(forKey: "colorMode") ?? "") ?? .off
    sppPipeline = defaults.bool(forKey: "sppPipeline")
    rgbHighlightRecovery = defaults.object(forKey: "rgbHighlightRecovery") as? Bool ?? true
    outputDirectory = defaults.string(forKey: "outputDirectory")
    debugLoggingEnabled = defaults.bool(forKey: "debugLoggingEnabled")
    onlyProcessNewItems = defaults.object(forKey: "onlyProcessNewItems") as? Bool ?? true
    sortField = defaults.string(forKey: "sortField") ?? "File Name"
    sortAscending = defaults.object(forKey: "sortAscending") as? Bool ?? true
  }

  private func loadNlmWindow(_ key: String, defaultValue: Int, maximum: Int) -> Int {
    let value = defaults.integer(forKey: key)
    return (1...maximum).contains(value) && value % 2 == 1 ? value : defaultValue
  }

  func saveSettings() {
    defaults.set(outputFormat.rawValue, forKey: "outputFormat")
    defaults.set(compress, forKey: "compress")
    defaults.set(denoiseIntensity, forKey: "denoiseIntensity")
    defaults.set(denoiseAlgorithm.rawValue, forKey: "denoiseAlgorithm")
    defaults.set(denoiseBackend.rawValue, forKey: "denoiseBackend")
    defaults.set(denoiseLuminance, forKey: "denoiseLuminance")
    defaults.set(denoiseChroma, forKey: "denoiseChroma")
    defaults.set(denoiseStrength, forKey: "denoiseStrength")
    defaults.set(nlmLumaPatch, forKey: "nlmLumaPatch")
    defaults.set(nlmChromaPatch, forKey: "nlmChromaPatch")
    defaults.set(nlmLumaSearch, forKey: "nlmLumaSearch")
    defaults.set(nlmChromaSearch, forKey: "nlmChromaSearch")
    defaults.set(colorProfile.rawValue, forKey: "colorProfile")
    defaults.set(dngHighlightRecovery, forKey: "dngHighlightRecovery")
    defaults.set(cineon, forKey: "cineon")
    defaults.set(colorMode.rawValue, forKey: "colorMode")
    defaults.set(sppPipeline, forKey: "sppPipeline")
    defaults.set(rgbHighlightRecovery, forKey: "rgbHighlightRecovery")
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

  /// Returns true for TIFF with rendered RGB. Color modes, SPP, and the chroma LUT need it.
  func rendersRgbTiff(_ format: OutputFormat, _ profile: ColorProfile) -> Bool {
    return format == .tiff && !cineon && profile != .none
  }

  var shouldShowRgbTiffOptions: Bool {
    return rendersRgbTiff(outputFormat, colorProfile)
  }

  var shouldShowColorModeOption: Bool {
    return outputFormat == .dng || shouldShowRgbTiffOptions
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
