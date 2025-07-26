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
    
    // MARK: - Opcode File Detection
    
    func getOpcodeFile(for file: X3FFile) -> String? {
        guard let opcodesDir = opcodesDirectory else {
            logger.logError("Opcodes directory not available", file: file.fileName)
            return nil
        }
        
        guard let cameraModel = file.cameraModel,
              let aperture = file.aperture else {
            logger.logError("Missing camera model or aperture data", file: file.fileName)
            return nil
        }
        
        let modelId = extractModelId(from: cameraModel)
        let opcodeFileName = buildOpcodeFileName(modelId: modelId, lensId: file.lensId, aperture: aperture)
        
        let opcodeFilePath = opcodesDir.appendingPathComponent(opcodeFileName)
        
        if FileManager.default.fileExists(atPath: opcodeFilePath.path) {
            logger.logOpcodeSelection(file.fileName, opcodePath: opcodeFilePath.path)
            return opcodeFilePath.path
        } else {
            logger.logOpcodeSelection(file.fileName, opcodePath: nil)
            logger.logError("Opcode file not found: \(opcodeFileName)", file: file.fileName)
            return nil
        }
    }
    
    private func extractModelId(from cameraModel: String) -> String {
        // Based on the bash script logic and Qt example
        if cameraModel.contains("DP1 Merrill") {
            return "DP1M"
        } else if cameraModel.contains("DP2 Merrill") {
            return "DP2M"
        } else if cameraModel.contains("DP3 Merrill") {
            return "DP3M"
        } else if cameraModel.contains("SD1 Merrill") {
            return "SD1M"
        } else if cameraModel.contains("SD1") {
            return "SD1"
        } else {
            logger.logError("Unknown camera model: \(cameraModel)")
            return "UNKNOWN"
        }
    }
    
    private func buildOpcodeFileName(modelId: String, lensId: String?, aperture: String) -> String {
        // Based on the naming convention from the example opcodes
        // Format: <ModelId>[_<LensId>]_FF_DNG_Opcodelist3_<Aperture>
        
        var fileName = modelId
        
        // For SD1M and SD1, include lens ID in the filename
        if (modelId == "SD1M" || modelId == "SD1"), let lensId = lensId {
            let cleanLensId = cleanLensId(lensId)
            fileName += "_\(cleanLensId)"
        }
        
        fileName += "_FF_DNG_Opcodelist3_\(aperture)"
        
        return fileName
    }
    
    private func cleanLensId(_ lensId: String) -> String {
        // Based on the example script and actual opcode filenames
        // The lens ID should be formatted as "Unknown_(32776)_30mm"
        // Clean lens ID for filename (replace spaces and special characters)
        var cleanId = lensId
            .replacingOccurrences(of: " ", with: "_")
            .replacingOccurrences(of: "|", with: "_")
        
        // If the lens ID doesn't already contain the expected format, try to format it
        if !cleanId.contains("Unknown_") && !cleanId.contains("_30mm") {
            // Try to extract numeric lens ID and format it properly
            if let numericId = extractNumericLensId(from: lensId) {
                cleanId = "Unknown_(\(numericId))_30mm"
            }
        }
        
        return cleanId
    }
    
    private func extractNumericLensId(from lensId: String) -> Int? {
        // Try to extract numeric lens ID from various formats
        let patterns = [
            "\\((\\d+)\\)",  // Extract from parentheses like "(32776)"
            "^(\\d+)$",      // Pure numeric string
            "ID_(\\d+)",     // ID_32776 format
            "Lens_(\\d+)"    // Lens_32776 format
        ]
        
        for pattern in patterns {
            if let regex = try? NSRegularExpression(pattern: pattern),
               let match = regex.firstMatch(in: lensId, range: NSRange(lensId.startIndex..., in: lensId)),
               let range = Range(match.range(at: 1), in: lensId) {
                if let numericId = Int(String(lensId[range])) {
                    return numericId
                }
            }
        }
        
        return nil
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
