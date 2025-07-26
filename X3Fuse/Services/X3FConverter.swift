//
//  X3FConverter.swift
//  X3Fuse
//
//  Created by Sang Lee on 7/21/25.
//

import Foundation

class X3FConverter {
    static let shared = X3FConverter()
    
    private let logger = LoggingService.shared
    private let binaryManager = BinaryManager.shared
    private let settings = ConversionSettings.shared
    private var currentProcess: Process?
    
    private init() {}
    
    // MARK: - X3F Conversion
    
    func runX3FConversion(for file: X3FFile) async throws {
        guard let x3fPath = binaryManager.selectX3FBinary(for: file) else {
            throw ProcessingError.missingBinary("No suitable x3f_extract binary found")
        }
        
        var arguments = buildX3FArguments(for: file)
        arguments.append(file.url.path)
        
        // Get the effective output directory
        let effectiveOutputDir = settings.effectiveOutputDirectory(for: file.url)
        
        // Log detailed information for debugging
        logger.logDebug("[\(file.fileName)] x3f_extract path: \(x3fPath)")
        logger.logDebug("[\(file.fileName)] Input file path: \(file.url.path)")
        logger.logDebug("[\(file.fileName)] Output directory: \(effectiveOutputDir)")
        logger.logDebug(
            "[\(file.fileName)] Full command: \(x3fPath) \(arguments.joined(separator: " "))")
        
        // Check file permissions
        try validateFilePermissions(for: file, x3fPath: x3fPath, outputDir: effectiveOutputDir)
        
        logger.logCommand(x3fPath, arguments: arguments, file: file.fileName)
        
        let process = Process()
        process.executableURL = URL(fileURLWithPath: x3fPath)
        process.arguments = arguments
        
        // Set working directory to the effective output directory
        let outputDirectoryURL = URL(fileURLWithPath: effectiveOutputDir)
        process.currentDirectoryURL = outputDirectoryURL
        logger.logDebug("[\(file.fileName)] Process working directory: \(outputDirectoryURL.path)")
        
        // Log environment variables that might affect execution
        logEnvironmentVariables(for: file)
        
        let outputPipe = Pipe()
        let errorPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = errorPipe
        
        // Store the current process for cancellation
        currentProcess = process
        
        do {
            try process.run()
        } catch {
            let nsError = error as NSError
            logger.logError("Failed to start process: \(error.localizedDescription)", file: file.fileName)
            logger.logError(
                "Error Domain: \(nsError.domain), Code: \(nsError.code), UserInfo: \(nsError.userInfo)",
                file: file.fileName)
            
            // Additional debugging for common macOS security issues
            if nsError.domain == NSPOSIXErrorDomain && nsError.code == 1 {
                try handleSecurityError(for: file, x3fPath: x3fPath)
            }
            
            throw ProcessingError.conversionFailed("Failed to start x3f_extract process: \(error)")
        }
        
        let outputData = outputPipe.fileHandleForReading.readDataToEndOfFile()
        let errorData = errorPipe.fileHandleForReading.readDataToEndOfFile()
        
        process.waitUntilExit()
        
        // Clear the current process reference
        currentProcess = nil
        
        let output = String(data: outputData, encoding: .utf8) ?? ""
        let errorOutput = String(data: errorData, encoding: .utf8) ?? ""
        
        logger.logDebug("[\(file.fileName)] Process termination status: \(process.terminationStatus)")
        logger.logDebug(
            "[\(file.fileName)] Process termination reason: \(process.terminationReason.rawValue)")
        
        if !output.isEmpty {
            logger.logProcessOutput(output, file: file.fileName)
        }
        
        if !errorOutput.isEmpty {
            logger.logProcessError(errorOutput, file: file.fileName)
        }
        
        if process.terminationStatus != 0 {
            // Exit code 15 is SIGTERM, which means the process was terminated due to cancellation
            if process.terminationStatus == 15 {
                logger.logConversion(
                    "x3f_extract process was terminated due to cancellation", file: file.fileName)
                throw ProcessingError.conversionCancelled("Conversion was cancelled by user")
            } else {
                let errorMessage = "x3f_extract failed with exit code \(process.terminationStatus)"
                if !errorOutput.isEmpty {
                    throw ProcessingError.conversionFailed("\(errorMessage). Error: \(errorOutput)")
                } else {
                    throw ProcessingError.conversionFailed(errorMessage)
                }
            }
        }
        
        logger.logConversion("x3f_extract completed successfully", file: file.fileName)
    }
    
    // MARK: - Argument Building
    
    private func buildX3FArguments(for file: X3FFile) -> [String] {
        var args: [String] = []
        
        // Use file-specific settings if available, otherwise use global settings
        let outputFormat = file.outputFormat ?? settings.outputFormat
        let compress = file.compress ?? settings.compress
        let denoise = file.denoise ?? settings.denoise
        let fasterProcessing = file.fasterProcessing ?? settings.fasterProcessing
        let colorProfile = file.colorProfile ?? settings.colorProfile
        
        // Specify output directory - use custom directory if set, otherwise use input file directory
        let outputDirectory = settings.effectiveOutputDirectory(for: file.url)
        args.append("-o")
        args.append(outputDirectory)
        
        // Denoise setting (default is enabled, so add -no-denoise if disabled)
        if !denoise {
            args.append("-no-denoise")
        }
        
        // Compression (only for DNG and TIFF)
        if compress && (outputFormat == .dng || outputFormat == .tiff) {
            args.append("-compress")
        }
        
        // OpenCL acceleration
        if fasterProcessing {
            args.append("-ocl")
        }
        
        // Output format
        switch outputFormat {
        case .dng:
            // Default, no additional argument needed
            break
        case .embeddedJpg:
            args.append("-jpg")
        case .tiff:
            args.append("-tiff")
        }
        
        // Color profile
        if let colorArg = colorProfile.x3fArgument {
            args.append("-color")
            args.append(colorArg)
        }
        
        return args
    }
    
    // MARK: - Validation and Debugging
    
    private func validateFilePermissions(for file: X3FFile, x3fPath: String, outputDir: String) throws {
        let fileManager = FileManager.default
        let inputPath = file.url.path
        
        logger.logDebug(
            "[\(file.fileName)] Input file exists: \(fileManager.fileExists(atPath: inputPath))")
        logger.logDebug(
            "[\(file.fileName)] Input file readable: \(fileManager.isReadableFile(atPath: inputPath))")
        logger.logDebug(
            "[\(file.fileName)] Output directory exists: \(fileManager.fileExists(atPath: outputDir))")
        logger.logDebug(
            "[\(file.fileName)] Output directory writable: \(fileManager.isWritableFile(atPath: outputDir))"
        )
        logger.logDebug(
            "[\(file.fileName)] x3f_extract executable: \(fileManager.isExecutableFile(atPath: x3fPath))")
        
        // Check file attributes
        do {
            let inputAttributes = try fileManager.attributesOfItem(atPath: inputPath)
            logger.logDebug("[\(file.fileName)] Input file size: \(inputAttributes[.size] ?? "unknown")")
            logger.logDebug(
                "[\(file.fileName)] Input file permissions: \(inputAttributes[.posixPermissions] ?? "unknown")"
            )
            
            let x3fAttributes = try fileManager.attributesOfItem(atPath: x3fPath)
            logger.logDebug(
                "[\(file.fileName)] x3f_extract permissions: \(x3fAttributes[.posixPermissions] ?? "unknown")"
            )
            
        } catch {
            logger.logError("Failed to get file attributes: \(error)", file: file.fileName)
        }
    }
    
    private func logEnvironmentVariables(for file: X3FFile) {
        let environment = ProcessInfo.processInfo.environment
        let relevantEnvVars = ["PATH", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH", "TMPDIR"]
        for envVar in relevantEnvVars {
            if let value = environment[envVar] {
                logger.logDebug("[\(file.fileName)] Environment \(envVar): \(value)")
            }
        }
    }
    
    private func handleSecurityError(for file: X3FFile, x3fPath: String) throws {
        logger.logError(
            "This appears to be a macOS security/permissions issue. Possible causes:",
            file: file.fileName)
        logger.logError("1. Binary is not code signed", file: file.fileName)
        logger.logError("2. Gatekeeper is blocking execution", file: file.fileName)
        logger.logError("3. App sandbox restrictions", file: file.fileName)
        logger.logError("4. System Integrity Protection (SIP) restrictions", file: file.fileName)
        
        // Try to get more detailed error information
        let detailedProcess = Process()
        detailedProcess.executableURL = URL(fileURLWithPath: "/usr/bin/spctl")
        detailedProcess.arguments = ["-a", "-t", "exec", "-vv", x3fPath]
        
        let detailedPipe = Pipe()
        detailedProcess.standardError = detailedPipe
        
        do {
            try detailedProcess.run()
            detailedProcess.waitUntilExit()
            
            let detailedData = detailedPipe.fileHandleForReading.readDataToEndOfFile()
            let detailedOutput = String(data: detailedData, encoding: .utf8) ?? ""
            logger.logError("Gatekeeper assessment: \(detailedOutput)", file: file.fileName)
        } catch {
            logger.logError("Could not run Gatekeeper assessment: \(error)", file: file.fileName)
        }
    }
    
    // MARK: - Process Management
    
    func terminateCurrentProcess() {
        if let process = currentProcess, process.isRunning {
            logger.logConversion("Terminating current x3f_extract process")
            process.terminate()
            currentProcess = nil
        }
    }
    
    var isProcessRunning: Bool {
        return currentProcess?.isRunning ?? false
    }
}
