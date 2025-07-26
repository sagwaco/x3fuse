//
//  FileQueueSortingUtilities.swift
//  X3Fuse
//
//  Created by Sang Lee on 7/21/25.
//

import Foundation

struct FileQueueSortingUtilities {
  
  /// Updates sort order based on settings
  static func createSortOrder(from settings: ConversionSettings) -> [KeyPathComparator<X3FFile>] {
    let comparator: KeyPathComparator<X3FFile>

    switch settings.sortField {
    case "File Name":
      comparator = KeyPathComparator(
        \X3FFile.fileName, order: settings.sortAscending ? .forward : .reverse)
    case "Status":
      comparator = KeyPathComparator(
        \X3FFile.displayStatus, order: settings.sortAscending ? .forward : .reverse)
    case "Date":
      comparator = KeyPathComparator(
        \X3FFile.sortableCapturedDate, order: settings.sortAscending ? .forward : .reverse)
    case "Size":
      comparator = KeyPathComparator(
        \X3FFile.sortableFileSize, order: settings.sortAscending ? .forward : .reverse)
    default:
      comparator = KeyPathComparator(\X3FFile.fileName, order: .forward)
    }

    return [comparator]
  }
  
  /// Updates settings based on sort order
  static func updateSettings(from sortOrder: [KeyPathComparator<X3FFile>], settings: ConversionSettings) {
    guard let firstComparator = sortOrder.first else { return }

    let fieldName: String
    switch firstComparator.keyPath {
    case \X3FFile.fileName:
      fieldName = "File Name"
    case \X3FFile.displayStatus:
      fieldName = "Status"
    case \X3FFile.sortableCapturedDate:
      fieldName = "Date"
    case \X3FFile.sortableFileSize:
      fieldName = "Size"
    default:
      fieldName = "File Name"
    }

    settings.sortField = fieldName
    settings.sortAscending = firstComparator.order == .forward
    settings.saveSettings()
  }
  
  /// Sorts files based on the provided sort order
  static func sortFiles(_ files: [X3FFile], using sortOrder: [KeyPathComparator<X3FFile>]) -> [X3FFile] {
    guard let firstComparator = sortOrder.first else {
      return files
    }

    return files.sorted { file1, file2 in
      let result: Bool

      switch firstComparator.keyPath {
      case \X3FFile.fileName:
        result = file1.fileName.localizedCaseInsensitiveCompare(file2.fileName) == .orderedAscending
      case \X3FFile.displayStatus:
        result =
          file1.displayStatus.localizedCaseInsensitiveCompare(file2.displayStatus)
          == .orderedAscending
      case \X3FFile.sortableCapturedDate:
        result = file1.sortableCapturedDate < file2.sortableCapturedDate
      case \X3FFile.sortableFileSize:
        result = file1.sortableFileSize < file2.sortableFileSize
      default:
        result = file1.fileName.localizedCaseInsensitiveCompare(file2.fileName) == .orderedAscending
      }

      return firstComparator.order == .forward ? result : !result
    }
  }
}
