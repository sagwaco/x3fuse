//
//  MenuCommands.swift
//  X3Fuse
//
//  Created by Sang Lee on 7/8/25.
//

import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct MenuCommands: Commands {
  var body: some Commands {
    // App menu commands (for updates)
    CommandGroup(after: .appInfo) {
      Button(LocalizationService.updatesCheckForUpdates) {
        UpdaterService.shared.checkForUpdates()
      }
      .disabled(!UpdaterService.shared.canCheckForUpdates || UpdaterService.shared.isCheckingForUpdates)
      
      Divider()
    }
    
    // Help menu commands
    CommandGroup(replacing: .help) {
      Button(LocalizationService.menuHelpX3FuseHelp) {
        // TODO: Open help documentation
      }
      .keyboardShortcut("?", modifiers: .command)

      Divider()

      Button(LocalizationService.menuHelpShowDebugLogs) {
        LoggingService.shared.openLogDirectory()
      }
      .keyboardShortcut("l", modifiers: [.command, .shift])

      Button(LocalizationService.menuHelpClearDebugLogs) {
        LoggingService.shared.clearLogs()
      }
    }

    // File menu additions
    CommandGroup(after: .newItem) {
      Button(LocalizationService.menuFileAddX3FFiles) {
        openFilePanel()
      }
      .keyboardShortcut("o", modifiers: .command)

      Divider()

      Button(LocalizationService.menuFileSettings) {
        NotificationCenter.default.post(name: NSNotification.Name("ShowSettings"), object: nil)
      }
      .keyboardShortcut(",", modifiers: .command)
    }

    // Edit menu additions
    CommandGroup(after: .undoRedo) {
      Button(LocalizationService.menuEditSelectAllFiles) {
        ConversionQueue.shared.selectAll()
        NotificationCenter.default.post(name: NSNotification.Name("SelectAllFiles"), object: nil)
      }
      .keyboardShortcut("a", modifiers: .command)

      Button(LocalizationService.menuEditDeselectAllFiles) {
        ConversionQueue.shared.deselectAll()
        NotificationCenter.default.post(name: NSNotification.Name("DeselectAllFiles"), object: nil)
      }
      .keyboardShortcut("d", modifiers: .command)

      Divider()

      Button(LocalizationService.menuEditRemoveSelectedFiles) {
        ConversionQueue.shared.removeSelectedFiles()
      }
      .keyboardShortcut(.delete, modifiers: [])
      .disabled(ConversionQueue.shared.selectedFiles.isEmpty || ConversionQueue.shared.isProcessing)

      Button(LocalizationService.menuEditRemoveSelectedFiles) {
        ConversionQueue.shared.removeSelectedFiles()
      }
      .keyboardShortcut(.deleteForward, modifiers: [])
      .disabled(ConversionQueue.shared.selectedFiles.isEmpty || ConversionQueue.shared.isProcessing)
    }

    // Conversion menu
    CommandMenu(LocalizationService.menuConversionTitle) {
      Button(LocalizationService.menuConversionConvertAllFiles) {
        Task {
          await FileProcessor.shared.processAllFiles()
        }
      }
      .keyboardShortcut("r", modifiers: .command)
      .disabled(ConversionQueue.shared.files.isEmpty || ConversionQueue.shared.isProcessing)

      Button(LocalizationService.menuConversionStopConversion) {
        FileProcessor.shared.stopConversion()
      }
      .keyboardShortcut("s", modifiers: .command)
      .disabled(!ConversionQueue.shared.canCancel)

      Divider()

      Button(LocalizationService.menuConversionClearQueue) {
        ConversionQueue.shared.clearQueue()
      }
      .keyboardShortcut("k", modifiers: .command)
      .disabled(ConversionQueue.shared.files.isEmpty || ConversionQueue.shared.isProcessing)

      Divider()

      Button(LocalizationService.menuConversionRemoveFailedFiles) {
        ConversionQueue.shared.removeFailedFiles()
      }
      .disabled(!ConversionQueue.shared.hasFailedFiles || ConversionQueue.shared.isProcessing)

      Button(LocalizationService.menuConversionRemoveCompletedFiles) {
        ConversionQueue.shared.removeCompletedFiles()
      }
      .disabled(!ConversionQueue.shared.hasCompletedFiles || ConversionQueue.shared.isProcessing)

    }
  }

  private func openFilePanel() {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = true
    panel.canChooseDirectories = false
    panel.canChooseFiles = true
    panel.allowedContentTypes = [UTType(filenameExtension: "x3f") ?? UTType.data]
    panel.title = LocalizationService.dialogSelectX3FFilesTitle
    panel.message = LocalizationService.dialogSelectX3FFilesMessage

    if panel.runModal() == .OK {
      ConversionQueue.shared.addFiles(panel.urls)
    }
  }
}
