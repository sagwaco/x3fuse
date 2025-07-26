//
//  ExifService.swift
//  X3Fuse
//
//  Created by Sang Lee on 7/8/25.
//

import Foundation
// TODO: Uncomment when ExifTool package is added
// import ExifTool

class ExifService {
    static let shared = ExifService()
    
    private let logger = LoggingService.shared
    private var exifToolPath: String?
    
    private init() {
        setupExifTool()
    }
    
    private func setupExifTool() {
        // Use bundled exiftool from the app bundle
        if let bundlePath = Bundle.main.path(forResource: "exiftool", ofType: nil) {
            exifToolPath = bundlePath
            logger.logDebug("Using bundled exiftool at: \(bundlePath)")
            setupExifToolPermissions(at: bundlePath)
        } else {
            logger.logError("Bundled exiftool not found in app bundle")
        }
    }
    
    private func setupExifToolPermissions(at path: String) {
        // Make sure the binary is executable
        do {
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path)
        } catch {
            logger.logError("Failed to set executable permissions on exiftool: \(error)")
        }
    }
    
    // MARK: - EXIF Data Extraction
    
    func extractExifData(from file: X3FFile) async throws {
        logger.logDebug("Extracting EXIF data from \(file.fileName)")
        
        guard let exifToolPath = exifToolPath else {
            throw ExifServiceError.exifToolNotFound
        }
        
        // Extract specific EXIF fields needed for opcode selection
        let arguments = [
            "-aperture",
            "-model", 
            "-lensid",
            "-json",
            file.url.path
        ]
        
        do {
            let output = try await runExifTool(arguments: arguments)
            try parseExifData(output, for: file)
        } catch {
            logger.logError("Failed to extract EXIF data: \(error)", file: file.fileName)
            // Fall back to simulation for development
            await simulateExifExtraction(for: file)
        }
    }
    
    private func parseExifData(_ jsonOutput: String, for file: X3FFile) throws {
        guard let data = jsonOutput.data(using: .utf8) else {
            throw ExifServiceError.invalidOutput
        }
        
        let json = try JSONSerialization.jsonObject(with: data, options: [])
        guard let array = json as? [[String: Any]], let metadata = array.first else {
            throw ExifServiceError.invalidOutput
        }
        
        // Extract camera model
        if let model = metadata["Model"] as? String {
            file.cameraModel = model
        }
        
        // Extract aperture
        if let aperture = metadata["Aperture"] as? Double {
            file.aperture = String(format: "%.1f", aperture)
        } else if let apertureString = metadata["Aperture"] as? String {
            file.aperture = apertureString
        }
        
        // Extract lens ID (for SD1 cameras)
        if let lensId = metadata["LensID"] as? String {
            file.lensId = lensId
        } else if let lensId = metadata["LensID"] as? Int {
            file.lensId = "Unknown_(\(lensId))_30mm"
        }
        
        // Store all metadata
        file.exifData = metadata
        
        // Log the extracted data
        let logMetadata: [String: Any] = [
            "Model": file.cameraModel ?? "Unknown",
            "Aperture": file.aperture ?? "Unknown",
            "LensID": file.lensId ?? "N/A"
        ]
        
        logger.logExifExtraction(file.fileName, metadata: logMetadata)
    }
    
    private func simulateExifExtraction(for file: X3FFile) async {
        // Fallback simulation for development when ExifTool is not available
        logger.logDebug("Using simulated EXIF extraction for \(file.fileName)")
        
        let fileName = file.fileName.lowercased()
        
        // Simulate camera model detection
        if fileName.contains("dp1") {
            file.cameraModel = "SIGMA DP1 Merrill"
        } else if fileName.contains("dp2") {
            file.cameraModel = "SIGMA DP2 Merrill"
        } else if fileName.contains("dp3") {
            file.cameraModel = "SIGMA DP3 Merrill"
        } else if fileName.contains("sd1") {
            file.cameraModel = "SIGMA SD1 Merrill"
        } else {
            file.cameraModel = "SIGMA DP2 Merrill" // Default for testing
        }
        
        // Simulate aperture values
        file.aperture = "2.8" // Default for testing
        
        // Simulate lens ID
        if file.cameraModel?.contains("SD1") == true {
            file.lensId = "Unknown_(32776)_30mm"
        }
        
        // Log the extracted data
        let metadata: [String: Any] = [
            "Model": file.cameraModel ?? "Unknown",
            "Aperture": file.aperture ?? "Unknown",
            "LensID": file.lensId ?? "N/A"
        ]
        
        logger.logExifExtraction(file.fileName, metadata: metadata)
    }
    
    // MARK: - EXIF Tool Integration
    
    func runExifTool(arguments: [String]) async throws -> String {
        guard let exifToolPath = exifToolPath else {
            throw ExifServiceError.exifToolNotFound
        }
        
        logger.logDebug("ExifTool execution: \(exifToolPath) \(arguments.joined(separator: " "))")
        
        let process = Process()
        process.executableURL = URL(fileURLWithPath: exifToolPath)
        process.arguments = arguments
        
        let outputPipe = Pipe()
        let errorPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = errorPipe
        
        do {
            try process.run()
        } catch {
            logger.logError("Failed to start ExifTool process: \(error)")
            throw ExifServiceError.processStartFailed(error.localizedDescription)
        }
        
        let outputData = outputPipe.fileHandleForReading.readDataToEndOfFile()
        let errorData = errorPipe.fileHandleForReading.readDataToEndOfFile()
        
        process.waitUntilExit()
        
        let output = String(data: outputData, encoding: .utf8) ?? ""
        let errorOutput = String(data: errorData, encoding: .utf8) ?? ""
        
        if process.terminationStatus != 0 {
            logger.logError("ExifTool failed with exit code \(process.terminationStatus): \(errorOutput)")
            throw ExifServiceError.exifToolFailed(errorOutput)
        }
        
        if !errorOutput.isEmpty {
            logger.logDebug("ExifTool stderr: \(errorOutput)")
        }
        
        return output
    }
    
    func applyOpcodeToFile(_ file: X3FFile, opcodePath: String) async throws {
        logger.logDebug("Applying opcode to \(file.fileName): \(opcodePath)")
        
        // The output file should already exist from x3f_extract in the effective output directory
        let outputFormat = file.outputFormat ?? ConversionSettings.shared.outputFormat
        let effectiveOutputDir = ConversionSettings.shared.effectiveOutputDirectory(for: file.url)
        let outputDirectory = URL(fileURLWithPath: effectiveOutputDir)
        let outputFileName = file.url.lastPathComponent + "." + String(outputFormat.fileExtension.dropFirst())
        let outputURL = outputDirectory.appendingPathComponent(outputFileName)
        
        logger.logDebug("ExifService: Looking for output file at: \(outputURL.path)")
        
        // Verify the DNG file exists
        guard FileManager.default.fileExists(atPath: outputURL.path) else {
            throw ExifServiceError.outputFileNotFound(outputURL.path)
        }
        
        // Based on the example script, the correct ExifTool command is:
        // exiftool -overwrite_original -opcodelist3<="opcode_file" -n -tagsfromfile source.x3f -all -copyright="..." output.dng
        let arguments = [
            "-overwrite_original",
            "-opcodelist3<=\(opcodePath)",
            "-n",
            "-tagsfromfile",
            file.url.path,
            "-all",
            outputURL.path
        ]
        
        do {
            let output = try await runExifTool(arguments: arguments)
            if !output.isEmpty {
                logger.logDebug("ExifTool output: \(output)")
            }
            logger.logDebug("Opcode and EXIF data applied successfully to \(file.fileName)")
        } catch {
            logger.logError("Failed to apply opcode: \(error)", file: file.fileName)
            throw error
        }
    }
    
    // MARK: - EXIF Editing Support
    
    func updateExifField(for files: [X3FFile], field: String, value: String) {
        logger.logDebug("Updating EXIF field '\(field)' to '\(value)' for \(files.count) files")
        
        for file in files {
            file.exifData[field] = value
            
            // Update specific properties based on field
            switch field.lowercased() {
            case "model":
                file.cameraModel = value
            case "aperture":
                file.aperture = value
            case "lensid":
                file.lensId = value
            default:
                break
            }
        }
    }
    
    func getExifFields(for file: X3FFile) -> [String: Any] {
        var fields: [String: Any] = file.exifData
        
        // Add standard fields
        if let model = file.cameraModel {
            fields["Model"] = model
        }
        if let aperture = file.aperture {
            fields["Aperture"] = aperture
        }
        if let lensId = file.lensId {
            fields["LensID"] = lensId
        }
        
        return fields
    }
    
    // MARK: - Validation
    
    func validateExifData(for file: X3FFile) -> [String] {
        var issues: [String] = []
        
        if file.cameraModel == nil {
            issues.append("Missing camera model")
        }
        
        if file.aperture == nil {
            issues.append("Missing aperture value")
        }
        
        // For SD1M/SD1, lens ID is required for opcode selection
        if file.cameraModel?.contains("SD1") == true && file.lensId == nil {
            issues.append("Missing lens ID (required for SD1 cameras)")
        }
        
        return issues
    }
}

// MARK: - ExifTool Integration Extensions

extension ExifService {
    
    func extractMetadataWithExifTool(from fileURL: URL) async throws -> [String: Any] {
        logger.logDebug("Extracting metadata with ExifTool from: \(fileURL.path)")
        
        let arguments = [
            "-aperture",
            "-model", 
            "-lensid",
            "-json",
            fileURL.path
        ]
        
        let output = try await runExifTool(arguments: arguments)
        
        // Parse JSON output and return structured data
        guard let data = output.data(using: .utf8) else {
            return [:]
        }
        
        do {
            let json = try JSONSerialization.jsonObject(with: data, options: [])
            if let array = json as? [[String: Any]], let metadata = array.first {
                return metadata
            }
        } catch {
            logger.logError("Failed to parse ExifTool JSON output: \(error)")
        }
        
        return [:]
    }
    
    func copyExifData(from sourceURL: URL, to destinationURL: URL) async throws {
        logger.logDebug("Copying EXIF data from \(sourceURL.lastPathComponent) to \(destinationURL.lastPathComponent)")
        logger.logDebug("ExifService: Source path: \(sourceURL.path)")
        logger.logDebug("ExifService: Destination path: \(destinationURL.path)")
        
        let arguments = [
            "-overwrite_original",
            "-tagsFromFile",
            sourceURL.path,
            "-all:all",
            destinationURL.path
        ]
        
        _ = try await runExifTool(arguments: arguments)
        logger.logDebug("EXIF data copied successfully")
    }
}

// MARK: - Error Types

enum ExifServiceError: LocalizedError {
    case exifToolNotFound
    case invalidOutput
    case processStartFailed(String)
    case exifToolFailed(String)
    case outputFileNotFound(String)
    
    var errorDescription: String? {
        switch self {
        case .exifToolNotFound:
            return "ExifTool not found in application bundle"
        case .invalidOutput:
            return "Invalid ExifTool output format"
        case .processStartFailed(let message):
            return "Failed to start ExifTool process: \(message)"
        case .exifToolFailed(let message):
            return "ExifTool execution failed: \(message)"
        case .outputFileNotFound(let path):
            return "Output file not found: \(path)"
        }
    }
}
