//
//  FileQueueView.swift
//  X3Fuse
//
//  Created by Sang Lee on 7/8/25.
//

import SwiftUI
import UniformTypeIdentifiers

struct FileQueueView: View {
  private let queue = ConversionQueue.shared
  private let settings = ConversionSettings.shared
  @Binding var selectedFileIDs: Set<X3FFile.ID>
  @State private var isDragOver = false
  @State private var sortOrder = [KeyPathComparator(\X3FFile.fileName)]
  let onReconversion: (Set<X3FFile.ID>) -> Void

  var sortedFiles: [X3FFile] {
    // Access queue properties to ensure SwiftUI tracks changes
    let files = queue.files
    let _ = queue.isProcessing  // Track processing state changes
    let _ = queue.overallProgress  // Track progress changes

    return FileQueueSortingUtilities.sortFiles(files, using: sortOrder)
  }

  var body: some View {
    VStack(spacing: 0) {
      if queue.files.isEmpty {
        emptyStateView
      } else {
        tableView
      }
    }
    .onDrop(of: [.fileURL], isTargeted: $isDragOver) { providers in
      handleDrop(providers: providers)
    }
    .onAppear {
      updateSortOrder()
    }
    .onChange(of: settings.sortField) { _, _ in
      updateSortOrder()
    }
    .onChange(of: settings.sortAscending) { _, _ in
      updateSortOrder()
    }
  }

  // MARK: - Table View

  private var tableView: some View {
    Table(sortedFiles, selection: $selectedFileIDs, sortOrder: $sortOrder) {
      TableColumn("") { file in
        StatusIconView(file: file, isSelected: false)
      }
      .width(20)

      TableColumn(LocalizationService.queueColumnName, value: \.fileName) { file in
        Text(file.fileName)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      .width(min: 10, ideal: 200, max: .infinity)

      TableColumn(LocalizationService.queueColumnDate, value: \.sortableCapturedDate) { file in
        if let date = file.capturedDate {
          Text(DateFormattingUtilities.formatDateWithOrdinal(date))
        } else {
          Text(LocalizationService.placeholderDash)
        }
      }
      .width(min: 10, ideal: 200, max: .infinity)

      TableColumn(LocalizationService.queueColumnSize, value: \.sortableFileSize) { file in
        if let size = file.fileSize {
          Text(ByteCountFormatter.string(fromByteCount: size, countStyle: .file))
        } else {
          Text(LocalizationService.placeholderDash)
        }
      }
      .width(min: 10, ideal: 80, max: 100)
    }
    .contextMenu(forSelectionType: X3FFile.ID.self) { selection in
      if selection.isEmpty {
        // Context menu for empty space
        EmptySpaceContextMenu()
      } else {
        // Context menu for selected files
        FileContextMenu(selectedIDs: selection)
      }
    } primaryAction: { selection in
      handleDoubleClick(for: selection)
    }
    .overlay(
      // Drag over feedback for table view
      Group {
        if isDragOver {
          RoundedRectangle(cornerRadius: 8)
            .stroke(Color.accentColor.opacity(0.3), lineWidth: 2)
            .background(Color.accentColor.opacity(0.05))
            .animation(.snappy(duration: 0.2), value: isDragOver)
        }
      }
      .padding(4)
    )
    .onChange(of: sortOrder) { _, newOrder in
      FileQueueSortingUtilities.updateSettings(from: newOrder, settings: settings)
    }
    .onChange(of: selectedFileIDs) { _, newSelection in
      // Update the queue's selected files when table selection changes
      queue.selectedFiles = newSelection
    }
    .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name("SelectAllFiles"))) { _ in
      selectedFileIDs = Set(queue.files.map { $0.id })
    }
    .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name("DeselectAllFiles"))) { _ in
      selectedFileIDs = []
    }
  }

  // MARK: - Empty State

  private var emptyStateView: some View {
    VStack(spacing: 16) {
      Image(systemName: isDragOver ? "tray.fill" : "tray")
        .font(.system(size: 48))
        .foregroundColor(isDragOver ? .accentColor : .secondary)
        .animation(.snappy(duration: 0.2), value: isDragOver)
        .symbolEffect(.scale.up.byLayer, options: .nonRepeating, isActive: isDragOver)

      Text(LocalizationService.queueEmptyTitle)
        .font(.title2)
        .foregroundColor(.secondary)

      Text(LocalizationService.queueEmptyMessage)
        .font(.body)
        .foregroundColor(isDragOver ? .accentColor : .secondary)
        .multilineTextAlignment(.center)
        .animation(.snappy(duration: 0.2), value: isDragOver)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(
      Color(NSColor.textBackgroundColor)
        .overlay(
          Rectangle()
            .stroke(
              isDragOver ? Color.accentColor.opacity(0.5) : Color.clear,
              style: StrokeStyle(lineWidth: 2, dash: [8, 8])
            )
            .animation(.snappy(duration: 0.2), value: isDragOver)
        )
    )
  }

  // MARK: - Drag and Drop

  private func handleDrop(providers: [NSItemProvider]) -> Bool {
    var urls: [URL] = []
    let group = DispatchGroup()

    for provider in providers {
      if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
        group.enter()
        provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) {
          item, error in
          defer { group.leave() }

          if let data = item as? Data,
            let url = URL(dataRepresentation: data, relativeTo: nil)
          {
            // Filter for X3F files only
            if url.pathExtension.lowercased() == "x3f" {
              urls.append(url)
            }
          }
        }
      }
    }

    group.notify(queue: .main) {
      if !urls.isEmpty {
        self.queue.addFiles(urls)
      }
    }

    return true
  }

  // MARK: - Double Click Handler

  private func handleDoubleClick(for selection: Set<X3FFile.ID>) {
    // Get the files from the double-clicked selection
    let selectedFiles = queue.files.filter { selection.contains($0.id) }
    
    // Don't proceed if processing is already in progress
    guard !queue.isProcessing else { return }
    
    // Don't proceed if no files are selected
    guard !selectedFiles.isEmpty else { return }
    
    // Check if any selected files have existing output and need reconversion confirmation
    let reconvertableFiles = selectedFiles.filter { 
      $0.status == .completed || $0.status == .failed || $0.status == .warning 
    }
    
    if !reconvertableFiles.isEmpty {
      // Use reconversion flow for files that need confirmation
      let fileIDs = Set(selectedFiles.map { $0.id })
      NotificationCenter.default.post(
        name: NSNotification.Name("ReconvertSelectedFiles"),
        object: fileIDs
      )
    } else {
      // Regular conversion for queued files
      let fileIDs = Set(selectedFiles.map { $0.id })
      NotificationCenter.default.post(
        name: NSNotification.Name("ConvertSelectedFiles"),
        object: fileIDs
      )
    }
  }

  // MARK: - Sorting

  private func updateSortOrder() {
    sortOrder = FileQueueSortingUtilities.createSortOrder(from: settings)
  }
}

// MARK: - Preview

#Preview {
  FileQueueView(selectedFileIDs: .constant(Set<X3FFile.ID>()), onReconversion: { _ in })
    .frame(width: 800, height: 600)
}
