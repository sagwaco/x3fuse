//
//  OpcodeManager.swift
//  X3Fuse
//
//  Created by Sang Lee on 7/8/25.
//

import Foundation

class OpcodeManager {
    static let shared = OpcodeManager()
    
    private let logger = LoggingService.shared
    private var opcodesDirectory: URL?
    
    private init() {
        setupOpcodesDirectory()
    }
    
    private func setupOpcodesDirectory() {
        guard let bundlePath = Bundle.main.path(forResource: "opcodes", ofType: nil) else {
            logger.logError("Opcodes directory not found in bundle")
            return
        }
        
        opcodesDirectory = URL(fileURLWithPath: bundlePath)
        logger.logDebug("Opcodes directory found at: \(bundlePath)")
    }

    // MARK: - Opcode Directory

    /// Path to the bundled opcodes directory, passed to x3f_extract via `-opcodes-dir`.
    /// x3f_extract selects and applies the appropriate flat-fielding opcode per file.
    var opcodesDirectoryPath: String? {
        opcodesDirectory?.path
    }

    // MARK: - Available Opcodes
    
    func getAvailableOpcodes() -> [String] {
        guard let opcodesDir = opcodesDirectory else { return [] }
        
        do {
            let contents = try FileManager.default.contentsOfDirectory(atPath: opcodesDir.path)
            return contents.filter { !$0.hasPrefix(".") } // Filter out hidden files
        } catch {
            logger.logError("Failed to read opcodes directory: \(error)")
            return []
        }
    }
    
    func getOpcodesForModel(_ modelId: String) -> [String] {
        let allOpcodes = getAvailableOpcodes()
        return allOpcodes.filter { $0.hasPrefix(modelId) }
    }
    
    // MARK: - Validation
    
    func validateOpcodesDirectory() -> Bool {
        guard let opcodesDir = opcodesDirectory else {
            logger.logError("Opcodes directory not found")
            return false
        }
        
        let availableOpcodes = getAvailableOpcodes()
        
        if availableOpcodes.isEmpty {
            logger.logError("No opcode files found in directory")
            return false
        }
        
        logger.logDebug("Found \(availableOpcodes.count) opcode files")
        
        // Check for expected camera models
        let expectedModels = ["DP1M", "DP2M", "DP3M", "SD1M"]
        var foundModels: Set<String> = []
        
        for opcode in availableOpcodes {
            for model in expectedModels {
                if opcode.hasPrefix(model) {
                    foundModels.insert(model)
                }
            }
        }
        
        logger.logDebug("Found opcodes for models: \(foundModels.sorted().joined(separator: ", "))")
        
        return !foundModels.isEmpty
    }
    
    // MARK: - Opcode Information
    
    func getOpcodeInfo(for fileName: String) -> [String: String] {
        var info: [String: String] = [:]
        
        // Parse filename to extract information
        let components = fileName.components(separatedBy: "_")
        
        if components.count >= 4 {
            info["model"] = components[0]
            
            // Find aperture (last component)
            if let aperture = components.last {
                info["aperture"] = aperture
            }
            
            // Check if lens ID is present (for SD1M/SD1)
            if components[0] == "SD1M" || components[0] == "SD1" {
                if components.count > 5 {
                    let lensComponents = Array(components[1..<components.count-4])
                    info["lens"] = lensComponents.joined(separator: "_")
                }
            }
        }
        
        return info
    }
}
