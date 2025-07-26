//
//  StatusIconView.swift
//  X3Fuse
//
//  Created by Sang Lee on 7/21/25.
//

import SwiftUI

struct StatusIconView: View {
  let file: X3FFile
  let isSelected: Bool

  var body: some View {
    Group {
      if file.status == .processing {
        ProgressView()
          .progressViewStyle(CircularProgressViewStyle())
          .scaleEffect(0.5)
      } else {
        Image(systemName: file.statusIcon)
          .foregroundColor(isSelected ? .primary : file.statusIconColor)
          .font(.system(size: 12))
      }
    }
    .frame(width: 16, height: 16)
    .help(tooltipText)
  }

  private var tooltipText: String {
    switch file.status {
    case .failed:
      return file.errorMessage ?? LocalizationService.statusConversionFailed
    case .warning:
      return file.warningMessage ?? LocalizationService.statusConversionCompletedWithWarnings
    default:
      return file.displayStatus
    }
  }
}
