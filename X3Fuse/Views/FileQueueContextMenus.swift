//
//  FileQueueContextMenus.swift
//  X3Fuse
//
//  Created by Sang Lee on 7/21/25.
//

import SwiftUI

struct FileContextMenu: View {
  let selectedIDs: Set<X3FFile.ID>
  @State private var queue = ConversionQueue.shared
  @State private var isProcessing = false

  var selectedFiles: [X3FFile] {
    queue.files.filter { selectedIDs.contains($0.id) }
  }

  var body: some View {
    let queuedFiles = selectedFiles.filter { $0.status == .queued }
    let completedFiles = selectedFiles.filter {
      $0.status == .completed || $0.status == .failed || $0.status == .warning
    }

    if !queuedFiles.isEmpty {
      Button(queuedFiles.count == 1 ? LocalizationService.contextConvert : LocalizationService.contextConvertSelected) {
        let fileIDs = Set(queuedFiles.map { $0.id })
        NotificationCenter.default.post(
          name: NSNotification.Name("ConvertSelectedFiles"),
          object: fileIDs
        )
      }
      .disabled(isProcessing)
    }

    if !completedFiles.isEmpty {
      Button(completedFiles.count == 1 ? LocalizationService.contextReconvert : LocalizationService.contextReconvertSelected) {
        let fileIDs = Set(completedFiles.map { $0.id })
        NotificationCenter.default.post(
          name: NSNotification.Name("ReconvertSelectedFiles"),
          object: fileIDs
        )
      }
      .disabled(isProcessing)
    }

    if queue.canCancel {
      Button(LocalizationService.contextStopConversion) {
        FileProcessor.shared.stopConversion()
      }

      Divider()
    }

    Button(selectedFiles.count == 1 ? LocalizationService.contextRemove : LocalizationService.contextRemoveSelected) {
      let fileIDs = Set(selectedFiles.map { $0.id })
      queue.removeFilesWithAnimation(fileIDs)
    }
    .disabled(isProcessing)

    Button(LocalizationService.contextShowInFinder) {
      let urls = selectedFiles.map { $0.url }
      if !urls.isEmpty {
        NSWorkspace.shared.activateFileViewerSelecting(urls)
      }
    }

    // Add option to open converted file in Finder for completed files
    let completedFilesWithOutput = selectedFiles.filter { 
      ($0.status == .completed || $0.status == .warning) && $0.outputFileExists 
    }
    
    if !completedFilesWithOutput.isEmpty {
      Button(completedFilesWithOutput.count == 1 ? LocalizationService.contextOpenConvertedInFinder : LocalizationService.contextOpenConvertedInFinderMultiple) {
        let outputUrls = completedFilesWithOutput.map { URL(fileURLWithPath: $0.outputFilePath) }
        if !outputUrls.isEmpty {
          NSWorkspace.shared.activateFileViewerSelecting(outputUrls)
        }
      }
    }

    Divider()

    let failedFiles = selectedFiles.filter { $0.status == .failed }
    let completedSelectedFiles = selectedFiles.filter {
      $0.status == .completed || $0.status == .warning
    }

    if !failedFiles.isEmpty {
      Button(failedFiles.count == 1 ? LocalizationService.contextRemoveFailedFile : LocalizationService.contextRemoveFailedFiles) {
        queue.removeFailedFilesWithAnimation()
      }
      .disabled(isProcessing)
    }

    if !completedSelectedFiles.isEmpty {
      Button(completedSelectedFiles.count == 1 ? LocalizationService.contextRemoveCompletedFile : LocalizationService.contextRemoveCompletedFiles)
      {
        queue.removeCompletedFilesWithAnimation()
      }
      .disabled(isProcessing)
    }

    if !failedFiles.isEmpty || !completedSelectedFiles.isEmpty {
      Divider()
    }

    Button(LocalizationService.contextDeselectAll) {
      NotificationCenter.default.post(
        name: NSNotification.Name("DeselectAllFiles"),
        object: nil
      )
    }
  }
}

struct EmptySpaceContextMenu: View {
  @State private var queue = ConversionQueue.shared
  @State private var isProcessing = false

  var body: some View {
    let hasQueuedFiles = queue.files.contains { $0.status == .queued }

    if hasQueuedFiles {
      Button(LocalizationService.contextConvertAll) {
        NotificationCenter.default.post(
          name: NSNotification.Name("ConvertAllFiles"),
          object: nil
        )
      }
      .disabled(isProcessing)
    }

    if !queue.files.isEmpty {
      Button(LocalizationService.contextRemoveAll) {
        queue.clearQueueWithAnimation()
      }
      .disabled(isProcessing)

      Divider()

      if queue.hasFailedFiles {
        Button(LocalizationService.contextRemoveFailedFiles) {
          queue.removeFailedFilesWithAnimation()
        }
        .disabled(isProcessing)
      }

      if queue.hasCompletedFiles {
        Button(LocalizationService.contextRemoveCompletedFiles) {
          queue.removeCompletedFilesWithAnimation()
        }
        .disabled(isProcessing)
      }
    }
  }
}
