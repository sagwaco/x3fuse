import Foundation
import Testing

@testable import X3Fuse

@Suite(.serialized)
final class ConversionSettingsTests {
  private let suiteName = "com.sagwa.X3FuseTests.\(UUID().uuidString)"
  private let defaults: UserDefaults

  init() throws {
    defaults = try #require(UserDefaults(suiteName: suiteName))
  }

  deinit {
    defaults.removePersistentDomain(forName: suiteName)
  }

  @Test func releaseDefaults() {
    let settings = ConversionSettings(defaults: defaults)
    #expect(settings.denoiseIntensity == 10)
    #expect(settings.denoiseAlgorithm == .nlm)
    #expect(settings.denoiseBackend == .auto)
    #expect(!settings.denoiseLuminance)
    #expect(settings.denoiseChroma)
    #expect(settings.denoiseStrength == 1)
    #expect(settings.nlmLumaPatch == 3 && settings.nlmChromaPatch == 3)
    #expect(settings.nlmLumaSearch == 11 && settings.nlmChromaSearch == 11)
    #expect(settings.buildDenoiseArguments().isEmpty)
  }

  @Test(arguments: [true, false])
  func legacyToggleMigration(enabled: Bool) {
    defaults.set(enabled, forKey: "denoise")
    let settings = ConversionSettings(defaults: defaults)
    #expect(settings.denoiseIntensity == (enabled ? 10 : 0))
    #expect(settings.denoiseAlgorithm == .nlm)
    #expect(settings.buildDenoiseArguments() == (enabled ? [] : ["-denoise", "0"]))
  }

  @Test func savedIntensityTakesPrecedence() {
    defaults.set(false, forKey: "denoise")
    defaults.set(6, forKey: "denoiseIntensity")
    let settings = ConversionSettings(defaults: defaults)
    #expect(settings.denoiseIntensity == 6)
    #expect(settings.buildDenoiseArguments() == ["-denoise", "6"])
  }

  @Test func denoiseSettingsRoundTrip() {
    let settings = ConversionSettings(defaults: defaults)
    settings.denoiseIntensity = 7
    settings.denoiseAlgorithm = .bm3d
    settings.denoiseBackend = .cpu
    settings.denoiseLuminance = true
    settings.denoiseChroma = false
    settings.denoiseStrength = 1.5
    settings.nlmLumaPatch = 5
    settings.nlmChromaPatch = 7
    settings.nlmLumaSearch = 21
    settings.nlmChromaSearch = 31
    settings.saveSettings()

    let restored = ConversionSettings(defaults: defaults)
    #expect(restored.denoiseAlgorithm == .bm3d)
    #expect(restored.denoiseBackend == .cpu)
    #expect(restored.nlmLumaPatch == 5 && restored.nlmChromaPatch == 7)
    #expect(restored.nlmLumaSearch == 21 && restored.nlmChromaSearch == 31)
    #expect(
      restored.buildDenoiseArguments() == [
        "-denoise", "7", "-denoiser", "bm3d", "-denoise-backend", "cpu",
        "-denoise-luma", "-no-denoise-chroma", "-denoise-strength", "1.5",
      ])
    restored.denoiseAlgorithm = .nlm
    #expect(
      restored.buildDenoiseArguments().suffix(8) == [
        "-nlm-luma-patch", "5", "-nlm-chroma-patch", "7",
        "-nlm-luma-search", "21", "-nlm-chroma-search", "31",
      ])
  }

  @Test func invalidSavedValuesUseValidDefaults() {
    defaults.set(99, forKey: "denoiseIntensity")
    defaults.set("unknown", forKey: "denoiseAlgorithm")
    defaults.set("unknown", forKey: "denoiseBackend")
    defaults.set(Double.nan, forKey: "denoiseStrength")
    defaults.set(2, forKey: "nlmLumaPatch")
    defaults.set(11, forKey: "nlmChromaPatch")
    defaults.set(-1, forKey: "nlmLumaSearch")
    defaults.set(33, forKey: "nlmChromaSearch")
    let settings = ConversionSettings(defaults: defaults)
    #expect(settings.denoiseIntensity == 10)
    #expect(settings.denoiseStrength == 1)
    #expect(settings.nlmLumaPatch == 3 && settings.nlmChromaPatch == 3)
    #expect(settings.nlmLumaSearch == 11 && settings.nlmChromaSearch == 11)
    #expect(settings.buildDenoiseArguments().isEmpty)
  }

  @Test(arguments: [0.0, 4.0, Double.infinity, -Double.infinity])
  func savedStrengthIsBounded(strength: Double) {
    defaults.set(strength, forKey: "denoiseStrength")
    let settings = ConversionSettings(defaults: defaults)
    #expect(settings.denoiseStrength.isFinite)
    #expect((0.1...3.0).contains(settings.denoiseStrength))
  }

  @Test func windowLimitsAndGpuBackendAreSupported() {
    defaults.set("gpu", forKey: "denoiseBackend")
    defaults.set(1, forKey: "nlmLumaPatch")
    defaults.set(9, forKey: "nlmChromaPatch")
    defaults.set(1, forKey: "nlmLumaSearch")
    defaults.set(31, forKey: "nlmChromaSearch")
    let settings = ConversionSettings(defaults: defaults)
    #expect(
      settings.buildDenoiseArguments() == [
        "-denoise-backend", "gpu", "-nlm-luma-patch", "1", "-nlm-chroma-patch", "9",
        "-nlm-luma-search", "1", "-nlm-chroma-search", "31",
      ])
  }

  @Test func disabledChannelsArePreserved() {
    let settings = ConversionSettings(defaults: defaults)
    settings.denoiseLuminance = false
    settings.denoiseChroma = false
    #expect(settings.buildDenoiseArguments() == ["-no-denoise-chroma"])
  }

  @Test func converterUsesSettingsAndFileIntensityOverride() {
    let settings = ConversionSettings(defaults: defaults)
    settings.outputFormat = .embeddedJpg
    settings.outputDirectory = "/tmp/denoise output"
    settings.denoiseIntensity = 4
    settings.denoiseAlgorithm = .bm3d
    settings.denoiseLuminance = true
    settings.dngHighlightRecovery = true
    settings.cineon = true
    let file = X3FFile(url: URL(fileURLWithPath: "/tmp/source photo.X3F"))
    file.outputFormat = .tiff
    file.compress = true
    file.colorProfile = .adobeRGB
    let converter = X3FConverter(settings: settings)
    #expect(
      converter.buildX3FArguments(for: file) == [
        "-o", "/tmp/denoise output", "-v", "-denoise", "4", "-denoiser", "bm3d",
        "-denoise-luma", "-compress", "-tiff", "-cineon", "-color", "AdobeRGB",
      ])

    file.denoiseIntensity = 0
    #expect(
      converter.buildX3FArguments(for: file) == [
        "-o", "/tmp/denoise output", "-v", "-denoise", "0", "-compress", "-tiff",
        "-cineon", "-color", "AdobeRGB",
      ])
    settings.denoiseIntensity = 0
    file.denoiseIntensity = 10
    let arguments = converter.buildX3FArguments(for: file)
    #expect(arguments.contains("-denoiser"))
    #expect(!arguments.contains("-denoise"))
  }

  @Test func dngDenoisePreservesHighlightAndOpcodeSelection() {
    let settings = ConversionSettings(defaults: defaults)
    settings.denoiseAlgorithm = .bm3d
    settings.dngHighlightRecovery = true
    let file = X3FFile(url: URL(fileURLWithPath: "/tmp/source.X3F"))
    let converter = X3FConverter(settings: settings)
    let recovered = converter.buildX3FArguments(for: file)
    #expect(recovered.contains("bm3d"))
    #expect(recovered.contains("-dng-highlight-recovery"))
    #expect(!recovered.contains("-opcodes-dir"))

    settings.dngHighlightRecovery = false
    let standard = converter.buildX3FArguments(for: file)
    #expect(standard.contains("bm3d"))
    #expect(!standard.contains("-dng-highlight-recovery"))
    #expect(standard.contains("-opcodes-dir") == (OpcodeManager.shared.opcodesDirectoryPath != nil))
  }

  @Test func coreRenderingSettingsRoundTrip() {
    let settings = ConversionSettings(defaults: defaults)
    #expect(settings.colorMode == .off && !settings.sppPipeline && settings.rgbHighlightRecovery)
    settings.colorMode = .tealAndOrange
    settings.sppPipeline = true
    settings.rgbHighlightRecovery = false
    settings.saveSettings()

    let restored = ConversionSettings(defaults: defaults)
    #expect(restored.colorMode == .tealAndOrange)
    #expect(restored.sppPipeline)
    #expect(!restored.rgbHighlightRecovery)
  }

  @Test func colorModeAndSppApplyOnlyToSupportedCameras() {
    let settings = ConversionSettings(defaults: defaults)
    settings.outputFormat = .tiff
    settings.colorMode = .vivid
    settings.sppPipeline = true
    settings.denoiseBackend = .gpu
    let converter = X3FConverter(settings: settings)
    let file = X3FFile(url: URL(fileURLWithPath: "/tmp/source.X3F"))

    file.cameraModel = "SIGMA DP1 Merrill"
    #expect(
      converter.buildX3FArguments(for: file) == [
        "-o", "/tmp", "-v", "-spp-pipeline", "-tiff", "-color-mode", "Vivid",
      ])

    // dp Quattro gets the color mode but not SPP, and keeps the denoise settings.
    file.cameraModel = "SIGMA dp0 Quattro"
    #expect(
      converter.buildX3FArguments(for: file) == [
        "-o", "/tmp", "-v", "-denoise-backend", "gpu", "-tiff", "-color-mode", "Vivid",
      ])

    // dp Quattro-only modes skip Merrill files.
    settings.colorMode = .cinema
    #expect(converter.buildX3FArguments(for: file).suffix(2) == ["-color-mode", "Cinema"])
    file.cameraModel = "SIGMA DP1 Merrill"
    #expect(!converter.buildX3FArguments(for: file).contains("-color-mode"))

    // sd Quattro, classic, and unknown cameras get neither option.
    for model in ["sd Quattro H", "SIGMA SD14", nil] {
      file.cameraModel = model
      let arguments = converter.buildX3FArguments(for: file)
      #expect(!arguments.contains("-color-mode"))
      #expect(!arguments.contains("-spp-pipeline"))
    }
  }

  @Test func colorModeAndSppRequireRenderedOutput() {
    let settings = ConversionSettings(defaults: defaults)
    settings.colorMode = .asShot
    settings.sppPipeline = true
    let converter = X3FConverter(settings: settings)
    let file = X3FFile(url: URL(fileURLWithPath: "/tmp/source.X3F"))
    file.cameraModel = "SIGMA SD1 Merrill"

    // DNG takes the color mode as its default profile; SPP is TIFF only.
    let dng = converter.buildX3FArguments(for: file)
    #expect(dng.suffix(2) == ["-color-mode", "as-shot"])
    #expect(!dng.contains("-spp-pipeline"))

    file.outputFormat = .embeddedJpg
    #expect(!converter.buildX3FArguments(for: file).contains("-color-mode"))

    // x3f_extract rejects both options for Cineon and unrendered TIFF.
    file.outputFormat = .tiff
    for (cineon, profile) in [(true, ColorProfile.sRGB), (false, .none)] {
      settings.cineon = cineon
      file.colorProfile = profile
      let arguments = converter.buildX3FArguments(for: file)
      #expect(!arguments.contains("-color-mode"))
      #expect(!arguments.contains("-spp-pipeline"))
      #expect(arguments.contains("-v"))
    }
  }

  @Test func rgbHighlightRecoveryDisablesChromaLutForTiffOnly() {
    let settings = ConversionSettings(defaults: defaults)
    settings.rgbHighlightRecovery = false
    let converter = X3FConverter(settings: settings)
    let file = X3FFile(url: URL(fileURLWithPath: "/tmp/source.X3F"))
    #expect(!converter.buildX3FArguments(for: file).contains("-no-chroma-lut"))
    file.outputFormat = .tiff
    #expect(converter.buildX3FArguments(for: file).contains("-no-chroma-lut"))
    settings.rgbHighlightRecovery = true
    #expect(!converter.buildX3FArguments(for: file).contains("-chroma-lut"))
    #expect(!converter.buildX3FArguments(for: file).contains("-no-chroma-lut"))
  }
}
