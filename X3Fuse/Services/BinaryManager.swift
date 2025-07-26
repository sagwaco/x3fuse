//
//  BinaryManager.swift
//  X3Fuse
//
//  Created by Sang Lee on 7/21/25.
//

import Foundation

class BinaryManager {
    static let shared = BinaryManager()
    
    private let logger = LoggingService.shared
    private var x3fExtractPath: String?
    
    private init() {
        setupX3FExtractPaths()
    }
    
    // MARK: - Binary Setup
    
    private func setupX3FExtractPaths() {
        // Setup standard x3f_extract binary
        if let bundlePath = Bundle.main.path(forResource: "x3f_extract", ofType: nil) {
            x3fExtractPath = bundlePath
            logger.logDebug("x3f_extract binary found at: \(bundlePath)")
            setupBinaryPermissions(at: bundlePath, name: "x3f_extract")
        } else {
            logger.logError("x3f_extract binary not found in bundle")
        }
    }
    
    private func setupBinaryPermissions(at path: String, name: String) {
        // Make sure the binary is executable
        do {
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path)
        } catch {
            logger.logError("Failed to set executable permissions on \(name): \(error)")
        }
    }
    
    // MARK: - Binary Selection
    
    func selectX3FBinary(for file: X3FFile) -> String? {
        // Default to standard x3f_extract
        if let standardPath = x3fExtractPath {
            if let cameraModel = file.cameraModel {
                logger.logDebug("[\(file.fileName)] Using standard x3f_extract for camera: \(cameraModel)")
            } else {
                logger.logDebug("[\(file.fileName)] Using standard x3f_extract (camera model unknown)")
            }
            return standardPath
        }
        
        return nil
    }
    
    // MARK: - Validation
    
    func validateBinaries() -> [String] {
        var issues: [String] = []
        
        if x3fExtractPath == nil {
            issues.append("x3f_extract binary not found in bundle")
        }
        
        return issues
    }
    
    // MARK: - Binary Information
    
    var standardBinaryPath: String? {
        return x3fExtractPath
    }
    
    var isStandardBinaryAvailable: Bool {
        return x3fExtractPath != nil
    }
}
