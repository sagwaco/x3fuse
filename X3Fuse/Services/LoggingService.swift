//
//  LoggingService.swift
//  X3Fuse
//
//  Created by Sang Lee on 7/8/25.
//

import Foundation
import AppKit

@Observable
class LoggingService {
    static let shared = LoggingService()
    
    private let logDirectory: URL
    private let conversionLogFile: URL
    private let errorLogFile: URL
    private let debugLogFile: URL
    
    private let dateFormatter: DateFormatter
    
    // This property will trigger UI updates when logs are cleared
    private var logsClearedTimestamp: Date = Date()
    
    private init() {
        // Create logs directory in ~/Library/Logs/X3Fuse/
        let homeDirectory = FileManager.default.homeDirectoryForCurrentUser
        logDirectory = homeDirectory.appendingPathComponent("Library/Logs/X3Fuse")
        
        conversionLogFile = logDirectory.appendingPathComponent("conversion.log")
        errorLogFile = logDirectory.appendingPathComponent("error.log")
        debugLogFile = logDirectory.appendingPathComponent("debug.log")
        
        dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        
        createLogDirectoryIfNeeded()
    }
    
    private func createLogDirectoryIfNeeded() {
        do {
            try FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
        } catch {
            print("Failed to create log directory: \(error)")
        }
    }
    
    private func writeToLog(file: URL, message: String) {
        let timestamp = dateFormatter.string(from: Date())
        let logEntry = "[\(timestamp)] \(message)\n"
        
        do {
            if FileManager.default.fileExists(atPath: file.path) {
                let fileHandle = try FileHandle(forWritingTo: file)
                fileHandle.seekToEndOfFile()
                fileHandle.write(logEntry.data(using: .utf8) ?? Data())
                fileHandle.closeFile()
            } else {
                try logEntry.write(to: file, atomically: true, encoding: .utf8)
            }
        } catch {
            print("Failed to write to log file \(file.lastPathComponent): \(error)")
        }
    }
    
    // MARK: - Public Logging Methods
    
    func logConversion(_ message: String, file: String = "") {
        let logMessage = file.isEmpty ? message : "[\(file)] \(message)"
        writeToLog(file: conversionLogFile, message: logMessage)
        print("CONVERSION: \(logMessage)")
    }
    
    func logError(_ error: String, file: String = "") {
        let logMessage = file.isEmpty ? error : "[\(file)] \(error)"
        writeToLog(file: errorLogFile, message: logMessage)
        print("ERROR: \(logMessage)")
    }
    
    func logDebug(_ message: String) {
        // Only log debug messages if debug logging is enabled
        guard ConversionSettings.shared.debugLoggingEnabled else { return }
        
        writeToLog(file: debugLogFile, message: message)
        print("DEBUG: \(message)")
    }
    
    func logCommand(_ command: String, arguments: [String], file: String = "") {
        let fullCommand = "\(command) \(arguments.joined(separator: " "))"
        let logMessage = file.isEmpty ? "Executing: \(fullCommand)" : "[\(file)] Executing: \(fullCommand)"
        logConversion(logMessage)
    }
    
    func logProcessOutput(_ output: String, file: String = "") {
        let logMessage = file.isEmpty ? "Process output: \(output)" : "[\(file)] Process output: \(output)"
        logDebug(logMessage)
    }
    
    func logProcessError(_ error: String, file: String = "") {
        let logMessage = file.isEmpty ? "Process error: \(error)" : "[\(file)] Process error: \(error)"
        logError(logMessage)
    }
    
    func logConversionStart(_ file: String) {
        logConversion("Starting conversion", file: file)
    }
    
    func logConversionComplete(_ file: String, duration: TimeInterval) {
        logConversion("Conversion completed in \(String(format: "%.2f", duration))s", file: file)
    }
    
    func logConversionFailed(_ file: String, error: String) {
        logError("Conversion failed: \(error)", file: file)
    }
    
    func logExifExtraction(_ file: String, metadata: [String: Any]) {
        let metadataString = metadata.map { "\($0.key): \($0.value)" }.joined(separator: ", ")
        logDebug("[\(file)] EXIF extracted: \(metadataString)")
    }
    
    func logOpcodeSelection(_ file: String, opcodePath: String?) {
        if let opcodePath = opcodePath {
            logDebug("[\(file)] Selected opcode: \(opcodePath)")
        } else {
            logDebug("[\(file)] No opcode file found")
        }
    }
    
    // MARK: - Log Management
    
    func openLogDirectory() {
        NSWorkspace.shared.open(logDirectory)
    }
    
    func clearLogs() {
        let logFiles = [conversionLogFile, errorLogFile, debugLogFile]
        
        for logFile in logFiles {
            do {
                if FileManager.default.fileExists(atPath: logFile.path) {
                    try FileManager.default.removeItem(at: logFile)
                }
            } catch {
                print("Failed to clear log file \(logFile.lastPathComponent): \(error)")
            }
        }
        
        // Update timestamp to trigger UI refresh
        logsClearedTimestamp = Date()
        
        logDebug("Log files cleared")
    }
    
    func getLogFilePaths() -> [String] {
        return [
            conversionLogFile.path,
            errorLogFile.path,
            debugLogFile.path
        ]
    }
    
    // MARK: - Log File Sizes
    
    func getLogFileSize(_ file: URL) -> String {
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
            if let size = attributes[.size] as? Int64 {
                return ByteCountFormatter.string(fromByteCount: size, countStyle: .file)
            }
        } catch {
            return "-"
        }
        return "0 bytes"
    }
    
    var conversionLogSize: String {
        _ = logsClearedTimestamp // Reference to trigger updates
        return getLogFileSize(conversionLogFile)
    }
    
    var errorLogSize: String {
        _ = logsClearedTimestamp // Reference to trigger updates
        return getLogFileSize(errorLogFile)
    }
    
    var debugLogSize: String {
        _ = logsClearedTimestamp // Reference to trigger updates
        return getLogFileSize(debugLogFile)
    }
}
