//
//  ContentView.swift
//  X3Fuse
//
//  Created by Sang Lee on 7/8/25.
//

import SwiftUI
import UniformTypeIdentifiers


struct ContentView: View {
  @State private var queue = ConversionQueue.shared
  @State private var settings = ConversionSettings.shared
  @State private var fileProcessor = FileProcessor.shared
  @State private var logger = LoggingService.shared

  @State private var selectedFile: X3FFile?
  @State private var setupIssues: [String] = []
  @State private var selectedFileIDs = Set<X3FFile.ID>()
  @State private var showingReconversionConfirmation = false
  @State private var filesToReconvert: [X3FFile] = []

  // MARK: - Computed Properties

  private var hasQueuedFiles: Bool {
    !queue.files.filter { $0.status == .queued }.isEmpty
  }

  private var hasSelectedQueuedFiles: Bool {
    !queue.files.filter { selectedFileIDs.contains($0.id) && $0.status == .queued }.isEmpty
  }

  private var hasSelectedReconvertableFiles: Bool {
    !queue.files.filter { 
      selectedFileIDs.contains($0.id) && 
      ($0.status == .completed || $0.status == .failed || $0.status == .warning) 
    }.isEmpty
  }

  private var hasReconvertableFiles: Bool {
    !queue.files.filter { $0.status == .completed || $0.status == .failed || $0.status == .warning }.isEmpty
  }

  private var canConvert: Bool {
    // Allow conversion as long as there are files in the queue and not currently processing
    // The FileProcessor will handle resetting files for reconversion as needed
    return !queue.files.isEmpty && !queue.isProcessing
  }

  private var outputDirectoryText: String {
    if settings.outputDirectory == nil {
      return LocalizationService.footerAlongsideOriginal
    } else {
      return settings.outputDirectoryDisplayName
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      // Main content area
      HSplitView {
        // Left panel - file list or drop zone
        VStack(spacing: 0) {
          if queue.files.isEmpty {
            dropZoneView
          } else {
            FileQueueView(selectedFileIDs: $selectedFileIDs, onReconversion: handleReconversion)
          }
        }
        .frame(minWidth: 300)
      }

      // Footer
      footerView
    }
    .onAppear {
      validateSetup()
      setupNotificationObservers()
    }
    .onDisappear {
      removeNotificationObservers()
    }
    .alert(LocalizationService.alertSetupIssuesTitle, isPresented: .constant(!setupIssues.isEmpty)) {
      Button(LocalizationService.buttonOK) {
        setupIssues.removeAll()
      }
    } message: {
      Text(setupIssues.joined(separator: "\n"))
    }
    .toolbar {
      if queue.canCancel {
        ToolbarItem(placement: .automatic) {
          Button(action: stopConversion) {
            Image(systemName: "stop.fill")
            Text(LocalizationService.buttonStop)
          }
          .buttonStyle(.bordered)
          .tint(.red)
          .help(LocalizationService.toolbarStopConversion)
          .disabled(!queue.canCancel)
        }
      }

      ToolbarItem(placement: .primaryAction) {
        HStack {
          Spacer(minLength: 0)
          Button(action: convertAll) {
            HStack {
              if queue.isProcessing {
                ProgressView()
                  .progressViewStyle(CircularProgressViewStyle())
                  .scaleEffect(0.5)
              } else {
                Text(LocalizationService.buttonConvert)
              }
            }
          }
          .buttonStyle(.borderedProminent)
          .help(
            queue.files.isEmpty
              ? LocalizationService.toolbarConvertAll : (!selectedFileIDs.isEmpty ? LocalizationService.toolbarConvertSelected : LocalizationService.toolbarConvertAll)
          )
          .disabled(!canConvert || queue.isProcessing)
          .keyboardShortcut(.defaultAction)
        }
      }
    }
    .navigationTitle(LocalizationService.appTitle)
    .overlay(
      // Reconversion confirmation popover
      Group {
        if showingReconversionConfirmation {
          ZStack {
            Color.black.opacity(0.3)
              .ignoresSafeArea()
              .onTapGesture {
                showingReconversionConfirmation = false
                filesToReconvert.removeAll()
              }

            ReconversionConfirmationView(
              conflictingFiles: filesToReconvert,
              onConfirm: {
                confirmReconversion()
              },
              onCancel: {
                showingReconversionConfirmation = false
                filesToReconvert.removeAll()
              }
            )
            .transition(.scale.combined(with: .opacity))
          }
        }
      }
      .animation(.easeInOut(duration: 0.2), value: showingReconversionConfirmation)
    )
  }

  // MARK: - Header View

  private var headerView: some View {
    HStack {

      // Convert all/selected button

    }
    .padding()
    .background(Color(NSColor.windowBackgroundColor))
  }

  // MARK: - Drop Zone View

  private var dropZoneView: some View {
    DropZoneView { urls in
      queue.addFiles(urls)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  // MARK: - Footer View

  private var footerView: some View {
    HStack {
      Button(action: addFiles) {
        Image(systemName: "plus")
      }
      .buttonStyle(.bordered)
      .controlSize(.regular)
      .help(LocalizationService.buttonAddFiles)

      Spacer()

      VStack {
        Text(LocalizationService.footerOutputDirectory)
          .font(.footnote)
          .foregroundColor(.secondary)
          .opacity(0.5)
        Text(outputDirectoryText)
          .font(.caption)
          .foregroundColor(.secondary)
          .truncationMode(.head)
      }

      Spacer()

      SettingsLink {
        Image(systemName: "gearshape")
      }
      .buttonStyle(.bordered)
      .controlSize(.regular)
      .help(LocalizationService.buttonSettings)
    }
    .frame(maxWidth: .infinity, maxHeight: 40)
    .padding(.horizontal, 8)
    .background(Color(NSColor.windowBackgroundColor))
    .overlay(
      Rectangle()
        .frame(height: 1)
        .foregroundColor(Color(NSColor.separatorColor)),
      alignment: .top
    )
  }

  // MARK: - Actions

  private func addFiles() {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = true
    panel.canChooseDirectories = false
    panel.canChooseFiles = true
    panel.allowedContentTypes = [UTType(filenameExtension: "x3f") ?? UTType.data]
    panel.title = LocalizationService.dialogSelectX3FFilesTitle
    panel.message = LocalizationService.dialogSelectX3FFilesMessage

    if panel.runModal() == .OK {
      queue.addFiles(panel.urls)
    }
  }

  private func clearQueue() {
    queue.clearQueue()
    selectedFile = nil
    selectedFileIDs.removeAll()
  }

  private func clearQueueOrRemoveSelected() {
    if selectedFileIDs.isEmpty || selectedFileIDs.count == queue.files.count {
      // No files selected or all files selected - clear the entire queue
      queue.clearQueueWithAnimation()
      selectedFile = nil
      selectedFileIDs.removeAll()
    } else {
      // Some files selected - remove only selected files
      queue.removeFilesWithAnimation(selectedFileIDs)
      selectedFileIDs.removeAll()
    }
  }

  private func convertAll() {
    if !selectedFileIDs.isEmpty {
      // Check if any selected files need reconversion confirmation (have existing output)
      let selectedFiles = queue.files.filter { selectedFileIDs.contains($0.id) }
      let reconvertableFiles = selectedFiles.filter { 
        $0.status == .completed || $0.status == .failed || $0.status == .warning 
      }
      
      if !reconvertableFiles.isEmpty {
        // Use reconversion flow which will check for existing output files and show confirmation if needed
        handleReconversion(for: selectedFileIDs)
      } else {
        // All selected files are queued or processing, proceed with regular conversion
        Task {
          await fileProcessor.processSelectedFiles(selectedFileIDs)
        }
      }
    } else {
      // No specific selection, process all files
      // Check if any files need reconversion confirmation
      let reconvertableFiles = queue.files.filter { 
        $0.status == .completed || $0.status == .failed || $0.status == .warning 
      }
      
      if !reconvertableFiles.isEmpty {
        // Some files may need reconversion confirmation
        let allFileIDs = Set(queue.files.map { $0.id })
        handleReconversion(for: allFileIDs)
      } else {
        // All files are queued, proceed with regular conversion
        Task {
          await fileProcessor.processAllFiles()
        }
      }
    }
  }

  private func validateSetup() {
    setupIssues = fileProcessor.validateSetup()

    if setupIssues.isEmpty {
      logger.logDebug("Application setup validation passed")
    } else {
      logger.logError("Application setup validation failed: \(setupIssues.joined(separator: ", "))")
    }
  }

  // MARK: - Notification Observers

  private func setupNotificationObservers() {
    NotificationCenter.default.addObserver(
      forName: NSNotification.Name("ConvertSelectedFiles"),
      object: nil,
      queue: .main
    ) { notification in
      if let fileIDs = notification.object as? Set<X3FFile.ID> {
        self.handleConvertSelected(fileIDs)
      }
    }

    NotificationCenter.default.addObserver(
      forName: NSNotification.Name("ConvertAllFiles"),
      object: nil,
      queue: .main
    ) { _ in
      self.handleConvertAll()
    }

    NotificationCenter.default.addObserver(
      forName: NSNotification.Name("ReconvertSelectedFiles"),
      object: nil,
      queue: .main
    ) { notification in
      if let fileIDs = notification.object as? Set<X3FFile.ID> {
        self.handleReconversion(for: fileIDs)
      }
    }

    NotificationCenter.default.addObserver(
      forName: NSNotification.Name("RemoveSelectedFiles"),
      object: nil,
      queue: .main
    ) { notification in
      if let fileIDs = notification.object as? Set<X3FFile.ID> {
        self.handleRemoveSelected(fileIDs)
      }
    }

    NotificationCenter.default.addObserver(
      forName: NSNotification.Name("RemoveAllFiles"),
      object: nil,
      queue: .main
    ) { _ in
      self.handleRemoveAll()
    }

    NotificationCenter.default.addObserver(
      forName: NSNotification.Name("DeselectAllFiles"),
      object: nil,
      queue: .main
    ) { _ in
      self.handleDeselectAll()
    }

    // Note: ShowSettings notification is not needed when using SettingsLink
    // The menu command will automatically open the Settings scene
  }

  private func removeNotificationObservers() {
    NotificationCenter.default.removeObserver(self)
  }

  // MARK: - Context Menu Action Handlers

  private func handleConvertSelected(_ fileIDs: Set<X3FFile.ID>) {
    Task {
      await fileProcessor.processSelectedFiles(fileIDs)
    }
  }

  private func handleConvertAll() {
    Task {
      await fileProcessor.processAllFiles()
    }
  }

  private func handleRemoveSelected(_ fileIDs: Set<X3FFile.ID>) {
    // Use animated removal
    queue.removeFilesWithAnimation(fileIDs)

    // Clear selection if any of the removed files were selected
    selectedFileIDs = selectedFileIDs.subtracting(fileIDs)

    // Clear selected file if it was removed
    if let selectedFile = selectedFile, fileIDs.contains(selectedFile.id) {
      self.selectedFile = nil
    }
  }

  private func handleRemoveAll() {
    queue.clearQueueWithAnimation()
    selectedFile = nil
    selectedFileIDs.removeAll()
  }

  private func handleDeselectAll() {
    selectedFileIDs.removeAll()
    selectedFile = nil
  }

  // MARK: - Re-conversion Handling

  private func handleReconversion(for fileIDs: Set<X3FFile.ID>) {
    let conflictingFiles = queue.getFilesWithExistingOutput(fileIDs)

    if conflictingFiles.isEmpty {
      // No conflicts, proceed directly with reconversion
      queue.resetFilesForReconversion(fileIDs)
      Task {
        await fileProcessor.processSelectedFiles(fileIDs)
      }
    } else {
      // Show confirmation dialog for files with existing output
      filesToReconvert = conflictingFiles
      showingReconversionConfirmation = true
    }
  }

  private func confirmReconversion() {
    let fileIDs = Set(filesToReconvert.map { $0.id })

    // Reset files for reconversion
    queue.resetFilesForReconversion(fileIDs)

    // Hide confirmation dialog
    showingReconversionConfirmation = false
    filesToReconvert.removeAll()

    // Start reconversion
    Task {
      await fileProcessor.processSelectedFiles(fileIDs)
    }
  }

  // MARK: - Stop Conversion

  private func stopConversion() {
    fileProcessor.stopConversion()
  }
}

#Preview {
  ContentView()
}
