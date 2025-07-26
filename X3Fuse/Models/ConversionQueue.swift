//
//  ConversionQueue.swift
//  X3Fuse
//
//  Created by Sang Lee on 7/8/25.
//

import Foundation
import SwiftUI

@Observable
class ConversionQueue {
  static let shared = ConversionQueue()

  var files: [X3FFile] = []
  var isProcessing: Bool = false
  var isCancelling: Bool = false
  var currentFileIndex: Int = 0
  var overallProgress: Double = 0.0
  var isSelected: Bool = false

  // Undo/Redo support for EXIF edits
  private var undoManager = UndoManager()

  private init() {}
  
  // MARK: - Sorted Files (matches table view order)
  
  var sortedFiles: [X3FFile] {
    let settings = ConversionSettings.shared
    
    let sortComparator: (X3FFile, X3FFile) -> Bool = { file1, file2 in
      let result: Bool
      
      switch settings.sortField {
      case "File Name":
        result = file1.fileName.localizedCaseInsensitiveCompare(file2.fileName) == .orderedAscending
      case "Status":
        result = file1.displayStatus.localizedCaseInsensitiveCompare(file2.displayStatus) == .orderedAscending
      case "Date":
        result = file1.sortableCapturedDate < file2.sortableCapturedDate
      case "Size":
        result = file1.sortableFileSize < file2.sortableFileSize
      default:
        result = file1.fileName.localizedCaseInsensitiveCompare(file2.fileName) == .orderedAscending
      }
      
      return settings.sortAscending ? result : !result
    }
    
    return files.sorted(by: sortComparator)
  }

  // MARK: - Queue Management

  func addFiles(_ urls: [URL]) {
    let x3fFiles = urls.compactMap { url -> X3FFile? in
      guard url.pathExtension.lowercased() == "x3f" else { return nil }
      let file = X3FFile(url: url)
      
      // Extract basic file metadata
      extractBasicFileMetadata(for: file)
      
      return file
    }

    files.append(contentsOf: x3fFiles)
  }
  
  // MARK: - File Metadata Extraction
  
  private func extractBasicFileMetadata(for file: X3FFile) {
    do {
      let attributes = try FileManager.default.attributesOfItem(atPath: file.url.path)
      
      // Extract file size
      if let fileSize = attributes[.size] as? Int64 {
        file.fileSize = fileSize
      }
      
      // Extract EXIF capture date from X3F file
      extractCaptureDate(for: file)
      
      // Fallback to file system dates if EXIF date not available
      if file.capturedDate == nil {
        if let creationDate = attributes[.creationDate] as? Date {
          file.capturedDate = creationDate
        } else if let modificationDate = attributes[.modificationDate] as? Date {
          file.capturedDate = modificationDate
        }
      }
      
    } catch {
      // Log error but don't fail file addition
      print("Failed to extract metadata for \(file.fileName): \(error)")
    }
  }
  
  private func extractCaptureDate(for file: X3FFile) {
    // Try to extract the actual capture date from X3F EXIF data
    // This is a simplified extraction - in a full implementation you'd use ExifTool or similar
    
    guard let fileHandle = try? FileHandle(forReadingFrom: file.url) else {
      return
    }
    
    defer {
      fileHandle.closeFile()
    }
    
    // Read the first 64KB to look for EXIF data
    let data = fileHandle.readData(ofLength: 65536)
    
    // Look for DateTime EXIF tag in the data
    // This is a basic implementation - X3F files contain EXIF data that includes capture time
    if let dateString = extractDateTimeFromExifData(data) {
      let formatter = DateFormatter()
      formatter.dateFormat = "yyyy:MM:dd HH:mm:ss"
      file.capturedDate = formatter.date(from: dateString)
    }
  }
  
  private func extractDateTimeFromExifData(_ data: Data) -> String? {
    // Look for common EXIF DateTime patterns in X3F files
    // X3F files store DateTime in format "YYYY:MM:DD HH:MM:SS"
    
    let dataString = String(data: data, encoding: .ascii) ?? ""
    
    // Look for DateTime pattern: YYYY:MM:DD HH:MM:SS
    let dateTimePattern = #"(\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2})"#
    
    if let regex = try? NSRegularExpression(pattern: dateTimePattern),
       let match = regex.firstMatch(in: dataString, range: NSRange(dataString.startIndex..., in: dataString)) {
      return String(dataString[Range(match.range, in: dataString)!])
    }
    
    return nil
  }

  func removeFile(_ file: X3FFile) {
    files.removeAll { $0.id == file.id }
    updateOverallProgress()
  }

  func removeFiles(at indices: IndexSet) {
    files.remove(atOffsets: indices)
    updateOverallProgress()
  }

  func removeFiles(_ fileIDs: Set<X3FFile.ID>) {
    files.removeAll { fileIDs.contains($0.id) }
    updateOverallProgress()
  }

  func removeSelectedFiles() {
    withAnimation(.easeInOut(duration: 0.3)) {
      removeFiles(selectedFiles)
      deselectAll()
    }
  }

  func clearQueue() {
    files.removeAll()
    selectedFiles.removeAll()
    currentFileIndex = 0
    overallProgress = 0.0
  }
  
  // MARK: - Animated Removal Methods
  
  func removeFileWithAnimation(_ file: X3FFile) {
    withAnimation(.easeInOut(duration: 0.3)) {
      removeFile(file)
    }
  }
  
  func removeFilesWithAnimation(at indices: IndexSet) {
    withAnimation(.easeInOut(duration: 0.3)) {
      removeFiles(at: indices)
    }
  }
  
  func removeFilesWithAnimation(_ fileIDs: Set<X3FFile.ID>) {
    withAnimation(.easeInOut(duration: 0.3)) {
      removeFiles(fileIDs)
    }
  }
  
  func clearQueueWithAnimation() {
    withAnimation(.easeInOut(duration: 0.3)) {
      clearQueue()
    }
  }

  // MARK: - Progress Tracking

  func updateFileProgress(_ file: X3FFile, progress: Double) {
    if let index = files.firstIndex(where: { $0.id == file.id }) {
      files[index].progress = progress
      updateOverallProgress()
    }
  }

  func updateFileStatus(_ file: X3FFile, status: ConversionStatus, message: String? = nil) {
    if let index = files.firstIndex(where: { $0.id == file.id }) {
      files[index].status = status

      switch status {
      case .failed:
        files[index].errorMessage = message
      case .warning:
        files[index].warningMessage = message
      case .completed:
        files[index].progress = 1.0
      default:
        break
      }

      updateOverallProgress()
    }
  }

  private func updateOverallProgress() {
    guard !files.isEmpty else {
      overallProgress = 0.0
      return
    }

    let totalProgress = files.reduce(0.0) { sum, file in
      switch file.status {
      case .completed: return sum + 1.0
      case .processing: return sum + file.progress
      default: return sum
      }
    }

    overallProgress = totalProgress / Double(files.count)
  }

  // MARK: - Queue Statistics

  var queuedCount: Int {
    files.filter { $0.status == .queued }.count
  }

  var processingCount: Int {
    files.filter { $0.status == .processing }.count
  }

  var completedCount: Int {
    files.filter { $0.status == .completed }.count
  }

  var failedCount: Int {
    files.filter { $0.status == .failed }.count
  }

  var warningCount: Int {
    files.filter { $0.status == .warning }.count
  }

  var totalCount: Int {
    files.count
  }

  // MARK: - EXIF Editing with Undo/Redo

  func updateExifData(
    for files: [X3FFile], keyPath: WritableKeyPath<X3FFile, String?>, value: String?
  ) {
    let oldValues = files.map { $0[keyPath: keyPath] }
    let fileIds = files.map { $0.id }

    // Register undo action
    undoManager.registerUndo(withTarget: self) { queue in
      for (index, oldValue) in oldValues.enumerated() {
        if let fileIndex = queue.files.firstIndex(where: { $0.id == fileIds[index] }) {
          queue.files[fileIndex][keyPath: keyPath] = oldValue
        }
      }
    }

    // Apply new values
    for file in files {
      if let fileIndex = self.files.firstIndex(where: { $0.id == file.id }) {
        self.files[fileIndex][keyPath: keyPath] = value
      }
    }
  }

  var canUndo: Bool {
    undoManager.canUndo
  }

  var canRedo: Bool {
    undoManager.canRedo
  }

  func undo() {
    undoManager.undo()
  }

  func redo() {
    undoManager.redo()
  }

  // MARK: - Selection Management

  var selectedFiles: Set<X3FFile.ID> = []

  func selectFile(_ file: X3FFile) {
    selectedFiles.insert(file.id)
  }

  func deselectFile(_ file: X3FFile) {
    selectedFiles.remove(file.id)
  }

  func toggleSelection(_ file: X3FFile) {
    if selectedFiles.contains(file.id) {
      deselectFile(file)
    } else {
      selectFile(file)
    }
  }

  func selectAll() {
    selectedFiles = Set(files.map { $0.id })
  }

  func deselectAll() {
    selectedFiles.removeAll()
  }

  var selectedFileObjects: [X3FFile] {
    files.filter { selectedFiles.contains($0.id) }
  }

  // MARK: - Conversion Summary

  func getConversionSummary() -> String {
    let completed = completedCount
    let failed = failedCount
    let warnings = warningCount
    let total = totalCount

    var summary = "Conversion completed: \(completed)/\(total) files processed"

    if failed > 0 {
      summary += ", \(failed) failed"
    }

    if warnings > 0 {
      summary += ", \(warnings) with warnings"
    }

    return summary
  }

  // MARK: - Re-conversion Support

  func resetFileForReconversion(_ file: X3FFile) {
    if let index = files.firstIndex(where: { $0.id == file.id }) {
      files[index].resetForReconversion()
      updateOverallProgress()
    }
  }

  func resetFilesForReconversion(_ fileIDs: Set<X3FFile.ID>) {
    for fileID in fileIDs {
      if let file = files.first(where: { $0.id == fileID }) {
        resetFileForReconversion(file)
      }
    }
  }

  func getFilesWithExistingOutput(_ fileIDs: Set<X3FFile.ID>) -> [X3FFile] {
    return files.filter { fileIDs.contains($0.id) && $0.outputFileExists }
  }

  // MARK: - Conversion Cancellation

  func cancelConversion() {
    isCancelling = true
    
    // First, collect files that are currently processing
    let processingFiles = files.filter { $0.status == .processing }
    
    // Clean up temporary files for processing files BEFORE resetting their status
    for file in processingFiles {
      cleanupTemporaryFilesForFile(file)
    }
    
    // Then reset processing files back to queued status
    for file in processingFiles {
      updateFileStatus(file, status: .queued)
    }
  }

  func resetCancellation() {
    isCancelling = false
    isProcessing = false
    currentFileIndex = 0
  }

  private func cleanupTemporaryFiles() {
    // Clean up any temporary files that might have been created during conversion
    // This method is kept for potential future use, but cancelConversion now handles this directly
    let processingFiles = files.filter { $0.status == .processing }
    for file in processingFiles {
      cleanupTemporaryFilesForFile(file)
    }
  }

  private func cleanupTemporaryFilesForFile(_ file: X3FFile) {
    // Clean up potential temporary files created during conversion
    let settings = ConversionSettings.shared
    let outputDirectory = settings.effectiveOutputDirectory(for: file.url)
    let fileManager = FileManager.default
    
    print("Cleaning up temporary files for \(file.fileName) in directory: \(outputDirectory)")
    
    // Look for temporary files with various patterns that x3f_extract might create
    let tempPatterns = [
      file.fileName + ".tmp",
      file.fileName + ".temp",
      file.fileName + ".dng.tmp",
      file.fileName + ".dng.temp",
      file.fileName + ".tif.tmp",
      file.fileName + ".tif.temp",
      file.fileName + ".jpg.tmp",
      file.fileName + ".jpg.temp"
    ]
    
    // Also check for partially written output files that might have been created
    let outputFormat = file.outputFormat ?? settings.outputFormat
    let partialOutputPatterns = [
      file.fileName + "." + String(outputFormat.fileExtension.dropFirst()),
      file.url.lastPathComponent + "." + String(outputFormat.fileExtension.dropFirst())
    ]
    
    // Combine all patterns
    let allPatterns = tempPatterns + partialOutputPatterns
    
    for pattern in allPatterns {
      let tempPath = (outputDirectory as NSString).appendingPathComponent(pattern)
      if fileManager.fileExists(atPath: tempPath) {
        do {
          try fileManager.removeItem(atPath: tempPath)
          print("Removed temporary/partial file: \(tempPath)")
        } catch {
          print("Failed to remove temporary file at \(tempPath): \(error)")
        }
      }
    }
    
    // Also try to list all files in the output directory to catch any unexpected temporary files
    do {
      let allFiles = try fileManager.contentsOfDirectory(atPath: outputDirectory)
      let baseFileName = file.url.deletingPathExtension().lastPathComponent
      
      // Look for any files that start with our base filename and might be temporary
      let potentialTempFiles = allFiles.filter { fileName in
        fileName.hasPrefix(baseFileName) && 
        (fileName.contains(".tmp") || fileName.contains(".temp") || fileName.contains("~"))
      }
      
      for tempFile in potentialTempFiles {
        let tempPath = (outputDirectory as NSString).appendingPathComponent(tempFile)
        do {
          try fileManager.removeItem(atPath: tempPath)
          print("Removed potential temporary file: \(tempPath)")
        } catch {
          print("Failed to remove potential temporary file at \(tempPath): \(error)")
        }
      }
    } catch {
      print("Could not list files in output directory for cleanup: \(error)")
    }
  }

  var canCancel: Bool {
    return isProcessing && !isCancelling
  }

  // MARK: - Selective File Removal

  func removeFailedFiles() {
    files.removeAll { $0.status == .failed }
    updateOverallProgress()
  }

  func removeCompletedFiles() {
    files.removeAll { $0.status == .completed || $0.status == .warning }
    updateOverallProgress()
  }
  
  func removeFailedFilesWithAnimation() {
    withAnimation(.easeInOut(duration: 0.3)) {
      removeFailedFiles()
    }
  }

  func removeCompletedFilesWithAnimation() {
    withAnimation(.easeInOut(duration: 0.3)) {
      removeCompletedFiles()
    }
  }

  var hasFailedFiles: Bool {
    return files.contains { $0.status == .failed }
  }

  var hasCompletedFiles: Bool {
    return files.contains { $0.status == .completed || $0.status == .warning }
  }

}
