//
//  SettingsView.swift
//  X3Fuse
//
//  Created by Sang Lee on 7/8/25.
//

import SwiftUI
import AppKit

struct SettingsView: View {
  @State private var settings = ConversionSettings.shared
  @State private var loggingService = LoggingService.shared
  @EnvironmentObject private var updaterService: UpdaterService
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Form {
        Section(LocalizationService.settingsSectionOutput) {
          VStack(alignment: .leading) {

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
            }
          }

          // Show custom directory controls only when toggle is off
          if !settings.outputToSameDirectory {

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
          }

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
            Toggle(LocalizationService.settingsRawCompression, isOn: $settings.compress)
              .help(LocalizationService.settingsRawCompressionHelp)
          }

          if settings.shouldShowColorProfileOption {
            Picker(LocalizationService.settingsColorProfile, selection: $settings.colorProfile) {
              ForEach(ColorProfile.allCases, id: \.self) { profile in
                Text(profile.displayName).tag(profile)
              }
            }
            .pickerStyle(MenuPickerStyle())
          }
          Toggle(LocalizationService.settingsDenoise, isOn: $settings.denoise)
            .help(LocalizationService.settingsDenoiseHelp)

          Toggle(LocalizationService.settingsFasterProcessing, isOn: $settings.fasterProcessing)
            .help(LocalizationService.settingsFasterProcessingHelp)
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
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(LocalizationService.buttonCancel) {
            dismiss()
          }
        }

        ToolbarItem(placement: .confirmationAction) {
          Button(LocalizationService.buttonDone) {
            settings.saveSettings()
            dismiss()
          }
          .buttonStyle(.borderedProminent)
        }
      }
    }
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
