//
//  FileValidator.swift
//  X3Fuse
//
//  Created by Sang Lee on 7/21/25.
//

import Foundation

class FileValidator {
    static let shared = FileValidator()
    
    private let logger = LoggingService.shared
    private let settings = ConversionSettings.shared
    
    private init() {}
    
    // MARK: - Output Directory Management
    
    func ensureOutputDirectoryExists(for file: X3FFile) throws {
        let outputDirectory = settings.effectiveOutputDirectory(for: file.url)
        let outputDirectoryURL = URL(fileURLWithPath: outputDirectory)
        
        let fileManager = FileManager.default
        var isDirectory: ObjCBool = false
        
        // Check if directory already exists
        if fileManager.fileExists(atPath: outputDirectory, isDirectory: &isDirectory) {
            if isDirectory.boolValue {
                // Directory exists and is valid
                logger.logDebug("[\(file.fileName)] Output directory exists: \(outputDirectory)")
                return
            } else {
                // Path exists but is not a directory
                throw ProcessingError.conversionFailed(
                    "Output path exists but is not a directory: \(outputDirectory)")
            }
        }
        
        // Directory doesn't exist, create it
        do {
            try fileManager.createDirectory(
                at: outputDirectoryURL, withIntermediateDirectories: true, attributes: nil)
            logger.logDebug("[\(file.fileName)] Created output directory: \(outputDirectory)")
        } catch {
            throw ProcessingError.conversionFailed(
                "Failed to create output directory: \(error.localizedDescription)")
        }
    }
    
    // MARK: - File Validation
    
    func validateOutputFile(for file: X3FFile) throws {
        let outputURL = getOutputFileURL(for: file)
        
        guard FileManager.default.fileExists(atPath: outputURL.path) else {
            throw ProcessingError.missingOutputFile("Output file was not created: \(outputURL.path)")
        }
        
        // Check file size (should be > 0)
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: outputURL.path)
            if let size = attributes[FileAttributeKey.size] as? Int64, size == 0 {
                throw ProcessingError.invalidOutputFile("Output file is empty")
            }
        } catch {
            throw ProcessingError.validationFailed("Could not validate output file: \(error)")
        }
        
        logger.logConversion("Output file validated successfully", file: file.fileName)
    }
    
    // MARK: - File Permissions
    
    func setOutputFilePermissions(for file: X3FFile) throws {
        let outputURL = getOutputFileURL(for: file)
        
        guard FileManager.default.fileExists(atPath: outputURL.path) else {
            throw ProcessingError.missingOutputFile(
                "Output file not found when setting permissions: \(outputURL.path)")
        }
        
        // Set file permissions to allow read/write for owner, read for group and others (644)
        // This ensures the current user can read and write to the converted file
        do {
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o644], ofItemAtPath: outputURL.path)
            logger.logDebug(
                "[\(file.fileName)] Set file permissions to 644 for output file: \(outputURL.path)")
        } catch {
            // Log the error but don't fail the conversion - this is not critical
            logger.logError(
                "Failed to set file permissions on output file: \(error)", file: file.fileName)
            logger.logError("Output file: \(outputURL.path)", file: file.fileName)
        }
    }
    
    // MARK: - File Renaming
    
    func renameOutputFile(for file: X3FFile) throws {
        let outputFormat = file.outputFormat ?? settings.outputFormat
        
        // Only rename DNG files to remove .X3F from filename
        guard outputFormat == .dng else {
            return
        }
        
        // Current output file path (FILENAME.X3F.dng) in the effective output directory
        let outputDirectory = URL(fileURLWithPath: settings.effectiveOutputDirectory(for: file.url))
        let currentOutputFileName =
            file.url.lastPathComponent + "." + String(outputFormat.fileExtension.dropFirst())
        let currentOutputURL = outputDirectory.appendingPathComponent(currentOutputFileName)
        
        // Desired output file path (FILENAME.dng)
        // Remove the .X3F extension from the original filename and add the output extension
        let baseFileName = file.url.deletingPathExtension().lastPathComponent
        let finalOutputURL = outputDirectory.appendingPathComponent(baseFileName)
            .appendingPathExtension(String(outputFormat.fileExtension.dropFirst()))
        
        // Only rename if the current and final paths are different
        guard currentOutputURL.path != finalOutputURL.path else {
            logger.logDebug(
                "[\(file.fileName)] Output file already has correct name: \(finalOutputURL.path)")
            return
        }
        
        guard FileManager.default.fileExists(atPath: currentOutputURL.path) else {
            throw ProcessingError.missingOutputFile(
                "Output file not found for renaming: \(currentOutputURL.path)")
        }
        
        // Check if target file already exists and remove it if necessary
        if FileManager.default.fileExists(atPath: finalOutputURL.path) {
            do {
                try FileManager.default.removeItem(at: finalOutputURL)
                logger.logDebug(
                    "[\(file.fileName)] Removed existing file at target location: \(finalOutputURL.path)")
            } catch {
                throw ProcessingError.conversionFailed(
                    "Failed to remove existing file at target location: \(error)")
            }
        }
        
        // Rename the file
        do {
            try FileManager.default.moveItem(at: currentOutputURL, to: finalOutputURL)
            logger.logConversion(
                "Renamed output file from \(currentOutputURL.lastPathComponent) to \(finalOutputURL.lastPathComponent)",
                file: file.fileName)
        } catch {
            throw ProcessingError.conversionFailed("Failed to rename output file: \(error)")
        }
    }
    
    // MARK: - Helper Methods
    
    private func getOutputFileURL(for file: X3FFile) -> URL {
        let outputFormat = file.outputFormat ?? settings.outputFormat
        // x3f_extract creates files with the full original filename + new extension
        // The file will be in the effective output directory
        let outputDirectory = URL(fileURLWithPath: settings.effectiveOutputDirectory(for: file.url))
        let outputFileName =
            file.url.lastPathComponent + "." + String(outputFormat.fileExtension.dropFirst())
        return outputDirectory.appendingPathComponent(outputFileName)
    }
    
    // MARK: - Validation Utilities
    
    func getExpectedOutputPath(for file: X3FFile) -> String {
        return getOutputFileURL(for: file).path
    }
    
    func outputFileExists(for file: X3FFile) -> Bool {
        let outputURL = getOutputFileURL(for: file)
        return FileManager.default.fileExists(atPath: outputURL.path)
    }
    
    func getOutputFileSize(for file: X3FFile) -> Int64? {
        let outputURL = getOutputFileURL(for: file)
        
        guard FileManager.default.fileExists(atPath: outputURL.path) else {
            return nil
        }
        
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: outputURL.path)
            return attributes[FileAttributeKey.size] as? Int64
        } catch {
            logger.logError("Failed to get output file size: \(error)", file: file.fileName)
            return nil
        }
    }
}
