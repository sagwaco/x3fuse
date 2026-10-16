//
//  SettingsView.swift
//  X3Fuse
//
//  Created by Sang Lee on 7/8/25.
//

import AppKit
import SwiftUI

struct SettingsView: View {
  @State private var settings = ConversionSettings.shared
  @State private var loggingService = LoggingService.shared
  @State private var lastDenoiseIntensity: Int = 10
  @State private var advancedDenoiseExpanded = false
  @EnvironmentObject private var updaterService: UpdaterService

  var body: some View {
    NavigationStack {
      Form {
        Section(LocalizationService.settingsSectionOutput) {
          VStack(alignment: .leading, spacing: 8) {

            // Toggle for same directory vs custom directory
            Toggle(
              LocalizationService.settingsSaveAlongsideOriginal,
              isOn: Binding(
                get: { settings.outputToSameDirectory },
                set: { useSameDirectory in
                  if useSameDirectory {
                    settings.outputToSameDirectory = true
                  } else {
                    settings.outputToSameDirectory = false
                    // If no custom directory is set, prompt for selection
                    if settings.outputDirectory == nil {
                      selectOutputDirectory()
                    }
                  }
                }
              )
            )
            .help(LocalizationService.settingsSaveAlongsideOriginalHelp)

            if settings.outputToSameDirectory {
              // Description text
              Text(
                LocalizationService.settingsSaveAlongsideOriginalDescription
              )
              .font(.caption)
              .foregroundColor(.secondary)
              .fixedSize(horizontal: false, vertical: true)
            } else {
              // Show custom directory controls only when toggle is off
              HStack(spacing: 12) {
                Text(LocalizationService.settingsOutputLocation)

                Spacer()

                HStack {
                  if !settings.isOutputDirectoryValid() {
                    Image(systemName: "exclamationmark.triangle.fill")
                      .foregroundColor(.red)
                      .font(.caption)
                  }

                  Text(settings.outputDirectoryDisplayName)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundColor(settings.isOutputDirectoryValid() ? .secondary : .red)
                    .lineLimit(1)
                    .truncationMode(.head)
                    .help(settings.outputDirectoryDisplayName)

                  Button(LocalizationService.buttonBrowse) {
                    selectOutputDirectory()
                  }
                  .buttonStyle(.bordered)
                  .font(.caption)
                }
              }
              .frame(maxWidth: .infinity)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)

          Toggle(LocalizationService.settingsOnlyConvertNew, isOn: $settings.onlyProcessNewItems)
            .help(
              LocalizationService.settingsOnlyConvertNewHelp
            )
        }

        Section(LocalizationService.settingsSectionConversion) {
          // Output format picker
          Picker(LocalizationService.settingsConversionFormat, selection: $settings.outputFormat) {
            ForEach(OutputFormat.allCases, id: \.self) { format in
              Text(format.displayName).tag(format)
            }
          }
          .pickerStyle(MenuPickerStyle())

          // Compression toggle (only shown for DNG and TIFF)
          if settings.shouldShowCompressionOption {
            VStack {
              VStack(alignment: .leading) {
                Toggle(LocalizationService.settingsRawCompression, isOn: $settings.compress)
                  .help(LocalizationService.settingsRawCompressionHelp)
              }
              if settings.compress {
                // Warning text for compression
                HStack(alignment: .top, spacing: 4) {
                  Image(systemName: "info.circle.fill")
                    .foregroundColor(.secondary)
                    .symbolRenderingMode(.hierarchical)
                  Text(
                    LocalizationService.settingsRawCompressionWarning
                  )
                  .fixedSize(horizontal: false, vertical: true)
                  .foregroundColor(.secondary)
                  .font(.caption)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(
                  RoundedRectangle(cornerRadius: 8)
                    .fill(Color.secondary.opacity(0.1))
                )
              }
            }
          }

          // Merrill-generation DNG highlight recovery (only shown for DNG)
          if settings.shouldShowDngHighlightRecoveryOption {
            VStack {
              VStack(alignment: .leading) {
                Toggle(
                  LocalizationService.settingsDngHighlightRecovery,
                  isOn: $settings.dngHighlightRecovery
                )
                .help(LocalizationService.settingsDngHighlightRecoveryHelp)
              }
              if settings.dngHighlightRecovery {
                // Warning text for highlight recovery
                HStack(alignment: .top, spacing: 4) {
                  Image(systemName: "info.circle.fill")
                    .foregroundColor(.secondary)
                    .symbolRenderingMode(.hierarchical)
                  Text(
                    LocalizationService.settingsDngHighlightRecoveryWarning
                  )
                  .fixedSize(horizontal: false, vertical: true)
                  .foregroundColor(.secondary)
                  .font(.caption)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(
                  RoundedRectangle(cornerRadius: 8)
                    .fill(Color.secondary.opacity(0.1))
                )
              }
            }
          }

          // Chroma LUT highlight recovery (only shown for rendered RGB TIFF)
          if settings.shouldShowRgbTiffOptions {
            Toggle(
              LocalizationService.settingsRgbHighlightRecovery,
              isOn: $settings.rgbHighlightRecovery
            )
            .help(LocalizationService.settingsRgbHighlightRecoveryHelp)
          }

          // Cineon-style flat tone curve (only shown for TIFF)
          if settings.shouldShowCineonOption {
            Toggle(LocalizationService.settingsCineon, isOn: $settings.cineon)
              .help(LocalizationService.settingsCineonHelp)
          }

          if settings.shouldShowColorProfileOption {
            Picker(LocalizationService.settingsColorProfile, selection: $settings.colorProfile) {
              ForEach(ColorProfile.allCases, id: \.self) { profile in
                Text(profile.displayName).tag(profile)
              }
            }
            .pickerStyle(MenuPickerStyle())
          }
          if settings.shouldShowColorModeOption {
            colorModeControls
          }
          if settings.shouldShowRgbTiffOptions {
            VStack(alignment: .leading, spacing: 4) {
              Toggle(LocalizationService.settingsSppPipeline, isOn: $settings.sppPipeline)
              Text(LocalizationService.settingsSppPipelineHelp)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
          if settings.outputFormat != .embeddedJpg {
            denoiseControls
          }
        }

        Section(LocalizationService.settingsSectionDebug) {
          Toggle(LocalizationService.settingsDebugLogging, isOn: $settings.debugLoggingEnabled)
            .help(LocalizationService.settingsDebugLoggingHelp)

          HStack {
            Text(LocalizationService.settingsDebugLogs)
            Spacer()
            Button(LocalizationService.settingsOpenLogsFolder) {
              loggingService.openLogDirectory()
            }
            .buttonStyle(.bordered)

            Button(LocalizationService.settingsClearLogs) {
              loggingService.clearLogs()
            }
            .buttonStyle(.bordered)
          }

          // Log file sizes
          VStack(alignment: .leading, spacing: 4) {
            HStack {
              Text(LocalizationService.settingsLogConversion)
                .font(.caption)
                .foregroundColor(.secondary)
              Spacer()
              Text(loggingService.conversionLogSize)
                .font(.caption)
                .foregroundColor(.secondary)
            }

            HStack {
              Text(LocalizationService.settingsLogError)
                .font(.caption)
                .foregroundColor(.secondary)
              Spacer()
              Text(loggingService.errorLogSize)
                .font(.caption)
                .foregroundColor(.secondary)
            }

            HStack {
              Text(LocalizationService.settingsLogDebug)
                .font(.caption)
                .foregroundColor(.secondary)
              Spacer()
              Text(loggingService.debugLogSize)
                .font(.caption)
                .foregroundColor(.secondary)
            }
          }
        }

        Section(LocalizationService.settingsSectionUpdates) {
          Toggle(
            LocalizationService.updatesAutomaticUpdates,
            isOn: Binding(
              get: { updaterService.automaticallyChecksForUpdates },
              set: { updaterService.setAutomaticUpdateChecks(enabled: $0) }
            )
          )
          .help(LocalizationService.updatesAutomaticUpdatesHelp)

          Toggle(
            LocalizationService.updatesAutomaticDownload,
            isOn: Binding(
              get: { updaterService.automaticallyDownloadsUpdates },
              set: { updaterService.setAutomaticDownload(enabled: $0) }
            )
          )
          .help(LocalizationService.updatesAutomaticDownloadHelp)

          HStack {
            if updaterService.isCheckingForUpdates {
              ProgressView()
                .progressViewStyle(CircularProgressViewStyle())
                .scaleEffect(0.5)
            } else if let lastChecked = updaterService.lastUpdateCheckDate {
              Text(
                "\(LocalizationService.updatesLastChecked): \(DateFormatter.lastCheckedFormatter.string(from: lastChecked))"
              )
              .font(.caption)
              .foregroundColor(.secondary)
            } else {
              Text(
                "\(LocalizationService.updatesLastChecked): \(LocalizationService.updatesNever)"
              )
              .font(.caption)
              .foregroundColor(.secondary)
            }

            Spacer()

            Button(action: {
              updaterService.checkForUpdates()
            }) {
              HStack {
                if updaterService.isCheckingForUpdates {
                  Text(LocalizationService.updatesCheckingForUpdates)
                } else {
                  Text(LocalizationService.updatesCheckForUpdates)
                }
              }
            }
            .padding(2)
            .buttonStyle(.bordered)
            .disabled(!updaterService.canCheckForUpdates || updaterService.isCheckingForUpdates)
          }
        }

        Section(LocalizationService.settingsSectionAbout) {
          HStack {
            Text(LocalizationService.settingsVersion)
            Spacer()
            Text(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0")
              .foregroundColor(.secondary)
          }

          HStack {
            Text(LocalizationService.settingsBuild)
            Spacer()
            Text(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1")
              .foregroundColor(.secondary)
          }

          HStack {
            Text(LocalizationService.settingsAcknowledgements)
            Spacer()
            Button(LocalizationService.settingsViewLicenses) {
              openAcknowledgements()
            }
            .buttonStyle(.bordered)
          }
        }
      }
      .formStyle(GroupedFormStyle())
    }
    .onDisappear {
      // Auto-save settings when the window closes
      settings.saveSettings()
    }
    .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) {
      _ in
      settings.saveSettings()
    }
  }

  private var colorModeControls: some View {
    VStack(alignment: .leading, spacing: 4) {
      Picker(LocalizationService.settingsColorMode, selection: $settings.colorMode) {
        ForEach(CameraColorMode.allCases, id: \.self) { mode in
          // Group Off and As shot, the shared modes, and the dp Quattro modes
          if mode == .standard || mode == CameraColorMode.dpQuattroOnly.first {
            Divider()
          }
          Text(mode.displayName).tag(mode)
        }
      }
      Text(LocalizationService.settingsColorModeHelp)
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var denoiseControls: some View {
    VStack(alignment: .leading, spacing: 10) {
      Toggle(
        LocalizationService.settingsDenoise,
        isOn: Binding(
          get: { settings.denoiseIntensity > 0 },
          set: { enabled in
            if enabled {
              settings.denoiseIntensity = lastDenoiseIntensity
            } else {
              lastDenoiseIntensity = settings.denoiseIntensity
              settings.denoiseIntensity = 0
            }
          }
        )
      )
      .help(LocalizationService.settingsDenoiseHelp)

      if settings.denoiseIntensity > 0 {
        Picker(LocalizationService.settingsDenoiseAlgorithm, selection: $settings.denoiseAlgorithm)
        {
          ForEach(DenoiseAlgorithm.allCases, id: \.self) { algorithm in
            Text(algorithm.rawValue.uppercased()).tag(algorithm)
          }
        }

        Toggle(LocalizationService.settingsDenoiseLuminance, isOn: $settings.denoiseLuminance)
        Toggle(LocalizationService.settingsDenoiseChroma, isOn: $settings.denoiseChroma)
        if !settings.denoiseLuminance && !settings.denoiseChroma {
          Text(LocalizationService.settingsDenoiseDisabledChannels)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        LabeledContent(LocalizationService.settingsDenoiseIntensity) {
          VStack(spacing: 2) {
            Slider(
              value: Binding(
                get: { Double(settings.denoiseIntensity) },
                set: {
                  let value = Int($0.rounded())
                  settings.denoiseIntensity = value
                  lastDenoiseIntensity = value
                }
              ),
              in: 1...10,
              step: 1
            )
            .accessibilityLabel(LocalizationService.settingsDenoiseIntensity)
            HStack {
              Text(LocalizationService.settingsDenoiseIntensityLess)
                .font(.caption)
                .foregroundColor(.secondary)
                .bold()
              Spacer()
              Text(LocalizationService.settingsDenoiseIntensityMore)
                .font(.caption)
                .foregroundColor(.secondary)
                .bold()
            }
          }
          .alignmentGuide(VerticalAlignment.center) { d in
            d[.top] + 11
          }
        }
        .disabled(!settings.denoiseLuminance && !settings.denoiseChroma)

        DisclosureGroup(isExpanded: $advancedDenoiseExpanded) {
          advancedDenoiseControls
            .padding(.top, 12)
        } label: {
          Button {
            withAnimation {
              advancedDenoiseExpanded.toggle()
            }
          } label: {
            Text(LocalizationService.settingsDenoiseAdvanced)
              .frame(maxWidth: .infinity, alignment: .leading)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
        }
      }
    }
    .onAppear {
      if settings.denoiseIntensity > 0 {
        lastDenoiseIntensity = settings.denoiseIntensity
      }
    }
  }

  private var advancedDenoiseControls: some View {
    VStack(alignment: .leading, spacing: 10) {
      LabeledContent(LocalizationService.settingsDenoiseStrength) {
        Slider(
          value: Binding(
            get: { settings.denoiseStrength },
            set: { settings.denoiseStrength = ($0 * 10).rounded() / 10 }
          ),
          in: 0.1...3.0,
          step: 0.1
        )
        .accessibilityLabel(LocalizationService.settingsDenoiseStrength)
        Text(settings.denoiseStrength, format: .number.precision(.fractionLength(1)))
          .monospacedDigit()
      }
      .help(LocalizationService.settingsDenoiseStrengthHelp)

      Picker(LocalizationService.settingsDenoiseBackend, selection: $settings.denoiseBackend) {
        ForEach(DenoiseBackend.allCases, id: \.self) { backend in
          Text(
            backend == .auto
              ? LocalizationService.settingsDenoiseBackendAutomatic
              : backend.rawValue.uppercased()
          ).tag(backend)
        }
      }
      Text(LocalizationService.settingsDenoiseBackendHelp)
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)

      if settings.denoiseAlgorithm == .nlm {
        Stepper(value: $settings.nlmLumaPatch, in: 1...9, step: 2) {
          HStack {
            Text(LocalizationService.settingsDenoiseNlmLumaPatch)
            Spacer()
            Text(settings.nlmLumaPatch, format: .number)
              .monospacedDigit()
          }
        }
        .disabled(!settings.denoiseLuminance)
        Stepper(value: $settings.nlmLumaSearch, in: 1...31, step: 2) {
          HStack {
            Text(LocalizationService.settingsDenoiseNlmLumaSearch)
            Spacer()
            Text(settings.nlmLumaSearch, format: .number)
              .monospacedDigit()
          }
        }
        .disabled(!settings.denoiseLuminance)
        Stepper(value: $settings.nlmChromaPatch, in: 1...9, step: 2) {
          HStack {
            Text(LocalizationService.settingsDenoiseNlmChromaPatch)
            Spacer()
            Text(settings.nlmChromaPatch, format: .number)
              .monospacedDigit()
          }
        }
        .disabled(!settings.denoiseChroma)
        Stepper(value: $settings.nlmChromaSearch, in: 1...31, step: 2) {
          HStack {
            Text(LocalizationService.settingsDenoiseNlmChromaSearch)
            Spacer()
            Text(settings.nlmChromaSearch, format: .number)
              .monospacedDigit()
          }
        }
        .disabled(!settings.denoiseChroma)
        Text(LocalizationService.settingsDenoiseNlmWindowsHelp)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .disabled(!settings.denoiseLuminance && !settings.denoiseChroma)
  }

  private func selectOutputDirectory() {
    let panel = NSOpenPanel()
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    panel.canCreateDirectories = true
    panel.allowsMultipleSelection = false
    panel.title = LocalizationService.dialogSelectOutputDirectoryTitle
    panel.message = LocalizationService.dialogSelectOutputDirectoryMessage

    // Set initial directory to current output directory or user's Documents folder
    if let currentDir = settings.outputDirectory {
      panel.directoryURL = URL(fileURLWithPath: currentDir)
    } else {
      panel.directoryURL =
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
    }

    if panel.runModal() == .OK {
      if let selectedURL = panel.url {
        settings.outputDirectory = selectedURL.path
      }
    }
  }

  private func openAcknowledgements() {
    if let acknowledgementsPath = Bundle.main.path(forResource: "Acknowledgements", ofType: "txt") {
      let acknowledgementsURL = URL(fileURLWithPath: acknowledgementsPath)
      NSWorkspace.shared.open(acknowledgementsURL)
    }
  }
}

// MARK: - DateFormatter Extension
extension DateFormatter {
  static let lastCheckedFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateStyle = .short
    formatter.timeStyle = .short
    return formatter
  }()
}

#Preview {
  SettingsView()
    .environmentObject(UpdaterService.shared)
}
