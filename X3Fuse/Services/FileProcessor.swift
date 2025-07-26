//
//  FileProcessor.swift
//  X3Fuse
//
//  Created by Sang Lee on 7/8/25.
//

import AppKit
import Foundation
import UserNotifications

@Observable
class FileProcessor {
  static let shared = FileProcessor()

  private let logger = LoggingService.shared
  private let exifService = ExifService.shared
  private let opcodeManager = OpcodeManager.shared
  private let settings = ConversionSettings.shared
  private let queue = ConversionQueue.shared
  
  // New modular services
  private let binaryManager = BinaryManager.shared
  private let x3fConverter = X3FConverter.shared
  private let fileValidator = FileValidator.shared
  private let notificationManager = NotificationManager.shared

  private init() {}

  // MARK: - Main Conversion Process

  func processAllFiles() async {
    guard !queue.files.isEmpty else {
      logger.logError("No files in queue to process")
      return
    }

    logger.logConversion("Starting batch conversion of \(queue.files.count) files")
    queue.isProcessing = true

    let startTime = Date()
    var processedFileIDs = Set<X3FFile.ID>()

    // Continuously process files while there are queued files available
    while !queue.isCancelling {
      // Get files to process based on the onlyProcessNewItems setting
      let filesToProcess = queue.sortedFiles.filter { file in
        let notAlreadyProcessed = !processedFileIDs.contains(file.id)
        
        if settings.onlyProcessNewItems {
          // Only process files that are queued
          return file.status == .queued && notAlreadyProcessed
        } else {
          // Process all files in the queue, including already converted ones
          return notAlreadyProcessed
        }
      }
      
      // Break if no more files to process
      if filesToProcess.isEmpty {
        break
      }
      
      // Process each file
      for file in filesToProcess {
        // Check for cancellation before processing each file
        if queue.isCancelling {
          logger.logConversion("Conversion cancelled by user")
          break
        }

        // Mark this file as processed (even if it fails) to avoid reprocessing
        processedFileIDs.insert(file.id)

        // If the file has already been converted and we're reprocessing it, reset it to queued
        if file.status != .queued {
          file.resetForReconversion()
          logger.logConversion("Resetting file for reconversion: \(file.fileName)")
        }

        do {
          try await processFile(file)
        } catch ProcessingError.conversionCancelled {
          // Don't mark as failed if it was cancelled - the ConversionQueue will handle resetting status
          logger.logConversion("File conversion cancelled: \(file.fileName)")
        } catch {
          logger.logConversionFailed(file.fileName, error: error.localizedDescription)
          queue.updateFileStatus(file, status: .failed, message: error.localizedDescription)
        }
      }
    }

    queue.isProcessing = false

    let duration = Date().timeIntervalSince(startTime)

    if queue.isCancelling {
      logger.logConversion("Batch conversion cancelled after \(String(format: "%.2f", duration))s")
      queue.resetCancellation()
    } else {
      logger.logConversion("Batch conversion completed in \(String(format: "%.2f", duration))s")
      // Play completion sound and show notification
      await notificationManager.showCompletionNotification()
    }
  }

  func processFile(_ file: X3FFile) async throws {
    logger.logConversionStart(file.fileName)
    let startTime = Date()

    queue.updateFileStatus(file, status: .processing)

    // Check for cancellation before each step
    if queue.isCancelling {
      throw ProcessingError.conversionCancelled("Conversion cancelled by user")
    }

    // Step 0: Ensure output directory exists
    try fileValidator.ensureOutputDirectoryExists(for: file)

    // Step 1: Extract EXIF data
    queue.updateFileProgress(file, progress: 0.1)
    if queue.isCancelling {
      throw ProcessingError.conversionCancelled("Conversion cancelled by user")
    }
    try await exifService.extractExifData(from: file)

    // Step 2: Run x3f_extract conversion
    queue.updateFileProgress(file, progress: 0.3)
    if queue.isCancelling {
      throw ProcessingError.conversionCancelled("Conversion cancelled by user")
    }
    try await x3fConverter.runX3FConversion(for: file)

    // Step 3: Apply EXIF data and opcodes (only for DNG output)
    queue.updateFileProgress(file, progress: 0.7)
    if queue.isCancelling {
      throw ProcessingError.conversionCancelled("Conversion cancelled by user")
    }
    if (file.outputFormat ?? settings.outputFormat) == .dng {
      try await applyExifAndOpcodes(to: file)
    }

    // Step 4: Validate output
    queue.updateFileProgress(file, progress: 0.9)
    if queue.isCancelling {
      throw ProcessingError.conversionCancelled("Conversion cancelled by user")
    }
    try fileValidator.validateOutputFile(for: file)

    // Step 5: Set proper file permissions
    try fileValidator.setOutputFilePermissions(for: file)

    // Step 6: Rename output file to remove .X3F from filename (only for DNG files)
    if (file.outputFormat ?? settings.outputFormat) == .dng {
      try fileValidator.renameOutputFile(for: file)
    }

    queue.updateFileProgress(file, progress: 1.0)
    queue.updateFileStatus(file, status: .completed)

    let duration = Date().timeIntervalSince(startTime)
    logger.logConversionComplete(file.fileName, duration: duration)
  }


  // MARK: - EXIF and Opcode Application

  private func applyExifAndOpcodes(to file: X3FFile) async throws {
    let outputFormat = file.outputFormat ?? settings.outputFormat

    // x3f_extract creates files with the original filename + new extension
    // For example: "image.X3F" becomes "image.X3F.dng"
    // The file will be in the effective output directory
    let effectiveOutputDir = settings.effectiveOutputDirectory(for: file.url)
    let outputDirectory = URL(fileURLWithPath: effectiveOutputDir)
    let outputFileName =
      file.url.lastPathComponent + "." + String(outputFormat.fileExtension.dropFirst())
    let outputURL = outputDirectory.appendingPathComponent(outputFileName)

    // Debug logging to understand what's happening
    logger.logDebug("[\(file.fileName)] EXIF/Opcode: Input file: \(file.url.path)")
    logger.logDebug("[\(file.fileName)] EXIF/Opcode: Effective output dir: \(effectiveOutputDir)")
    logger.logDebug("[\(file.fileName)] EXIF/Opcode: Expected output file: \(outputURL.path)")
    logger.logDebug(
      "[\(file.fileName)] EXIF/Opcode: Custom output directory setting: \(settings.outputDirectory ?? "nil")"
    )

    // Check if output file exists
    guard FileManager.default.fileExists(atPath: outputURL.path) else {
      // List files in the effective output directory to help debug
      do {
        let files = try FileManager.default.contentsOfDirectory(atPath: effectiveOutputDir)
        logger.logDebug(
          "[\(file.fileName)] EXIF/Opcode: Files in output directory: \(files.joined(separator: ", "))"
        )
      } catch {
        logger.logDebug(
          "[\(file.fileName)] EXIF/Opcode: Could not list files in output directory: \(error)")
      }

      throw ProcessingError.missingOutputFile("Output file not found: \(outputURL.path)")
    }

    logger.logDebug("[\(file.fileName)] Output file found at: \(outputURL.path)")

    // Apply opcode if available
    if let opcodePath = opcodeManager.getOpcodeFile(for: file) {
      logger.logDebug("[\(file.fileName)] Applying opcode: \(opcodePath)")
      try await exifService.applyOpcodeToFile(file, opcodePath: opcodePath)
    } else {
      // Still copy EXIF data even without opcode
      logger.logDebug("[\(file.fileName)] No opcode found, copying EXIF data only")
      try await exifService.copyExifData(from: file.url, to: outputURL)

      // Log warning about missing opcode
      let warningMessage = "No flat-fielding opcode found for this camera/lens/aperture combination"
      logger.logError(warningMessage, file: file.fileName)
      queue.updateFileStatus(file, status: .warning, message: warningMessage)
    }
  }


  // MARK: - Selected Files Processing

  func processSelectedFiles(_ selectedFileIDs: Set<X3FFile.ID>) async {
    // Filter selected files from the sorted files list to maintain table view order
    // For re-conversion, we process all selected files regardless of current status
    let selectedFiles = queue.sortedFiles.filter { selectedFileIDs.contains($0.id) }

    guard !selectedFiles.isEmpty else {
      logger.logError("No selected files available for processing")
      return
    }

    logger.logConversion("Starting conversion of \(selectedFiles.count) selected files")
    
    // Reset cancellation state in case it was set from a previous operation
    queue.resetCancellation()
    queue.isProcessing = true

    let startTime = Date()

    for file in selectedFiles {
      // Check for cancellation before processing each file
      if queue.isCancelling {
        logger.logConversion("Conversion cancelled by user")
        break
      }
      
      // Ensure file is ready for processing (reset if needed)
      if file.status != .queued {
        file.resetForReconversion()
        logger.logConversion("Resetting file for reconversion: \(file.fileName)")
      }
      
      do {
        try await processFile(file)
      } catch ProcessingError.conversionCancelled {
        // Don't mark as failed if it was cancelled - the ConversionQueue will handle resetting status
        logger.logConversion("File conversion cancelled: \(file.fileName)")
        break
      } catch {
        logger.logConversionFailed(file.fileName, error: error.localizedDescription)
        queue.updateFileStatus(file, status: .failed, message: error.localizedDescription)
      }
    }

    queue.isProcessing = false

    let duration = Date().timeIntervalSince(startTime)
    
    if queue.isCancelling {
      logger.logConversion("Selected files conversion cancelled after \(String(format: "%.2f", duration))s")
      queue.resetCancellation()
    } else {
      logger.logConversion("Selected files conversion completed in \(String(format: "%.2f", duration))s")
      // Play completion sound and show notification
      await notificationManager.showCompletionNotification()
    }
  }

  // MARK: - Single File Processing

  func processSingleFile(_ file: X3FFile) async {
    do {
      try await processFile(file)
    } catch {
      logger.logConversionFailed(file.fileName, error: error.localizedDescription)
      queue.updateFileStatus(file, status: .failed, message: error.localizedDescription)
    }
  }


  // MARK: - Validation

  func validateSetup() -> [String] {
    var issues: [String] = []

    // Validate binaries
    issues.append(contentsOf: binaryManager.validateBinaries())

    // Validate opcodes directory
    if !opcodeManager.validateOpcodesDirectory() {
      issues.append("Opcodes directory validation failed")
    }

    return issues
  }

  // MARK: - Cancellation

  func stopConversion() {
    logger.logConversion("Stop conversion requested")
    queue.cancelConversion()

    // Terminate the current process if it's running
    x3fConverter.terminateCurrentProcess()
  }
}

// MARK: - Processing Errors

enum ProcessingError: LocalizedError {
  case missingBinary(String)
  case conversionFailed(String)
  case conversionCancelled(String)
  case missingOutputFile(String)
  case invalidOutputFile(String)
  case validationFailed(String)
  case exifProcessingFailed(String)

  var errorDescription: String? {
    switch self {
    case .missingBinary(let message):
      return "Missing binary: \(message)"
    case .conversionFailed(let message):
      return "Conversion failed: \(message)"
    case .conversionCancelled(let message):
      return "Conversion cancelled: \(message)"
    case .missingOutputFile(let message):
      return "Missing output file: \(message)"
    case .invalidOutputFile(let message):
      return "Invalid output file: \(message)"
    case .validationFailed(let message):
      return "Validation failed: \(message)"
    case .exifProcessingFailed(let message):
      return "EXIF processing failed: \(message)"
    }
  }
}
