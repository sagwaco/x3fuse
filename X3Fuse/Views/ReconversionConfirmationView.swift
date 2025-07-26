//
//  ReconversionConfirmationView.swift
//  X3Fuse
//
//  Created by Sang Lee on 7/11/25.
//

import SwiftUI

struct ReconversionConfirmationView: View {
  let conflictingFiles: [X3FFile]
  let onConfirm: () -> Void
  let onCancel: () -> Void

  @State private var isVisible = false

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      // Header
      HStack {
        Image(systemName: "exclamationmark.triangle.fill")
          .foregroundColor(.orange)
          .font(.title2)

        VStack(alignment: .leading, spacing: 2) {
          Text(LocalizationService.reconversionTitle)
            .font(.headline)
            .fontWeight(.semibold)

          Text(LocalizationService.reconversionMessage)
            .font(.subheadline)
            .foregroundColor(.secondary)
        }
      }

      // File list
      ScrollView {
        VStack(alignment: .leading, spacing: 8) {
          ForEach(conflictingFiles, id: \.id) { file in
            HStack {
              Image(systemName: "doc.fill")
                .foregroundColor(.secondary)
                .font(.caption)

              VStack(alignment: .leading, spacing: 2) {
                Text(file.outputFileName)
                  .font(.body)
                  .fontWeight(.medium)

                Text(
                  LocalizationService.reconversionLocationPrefix
                    + file.url.deletingLastPathComponent().lastPathComponent
                )
                .font(.caption)
                .foregroundColor(.secondary)
              }

              Spacer()
            }
            .padding(.vertical, 4)
            .padding(.horizontal, 8)
            .background(Color(NSColor.controlBackgroundColor))
            .cornerRadius(6)
          }
        }
      }
      .frame(maxHeight: 200)

      // Warning message
      HStack {
        Image(systemName: "info.circle.fill")
          .foregroundColor(.blue)
          .font(.caption)

        Text(LocalizationService.reconversionWarning)
          .font(.caption)
          .foregroundColor(.secondary)
      }
      .padding(.vertical, 8)
      .padding(.horizontal, 12)
      .background(Color.blue.opacity(0.1))
      .cornerRadius(8)

      // Buttons
      HStack {
        Spacer()

        Button(LocalizationService.buttonCancel) {
          onCancel()
        }
        .keyboardShortcut(.cancelAction)

        Button(LocalizationService.buttonOverwrite) {
          onConfirm()
        }
        .keyboardShortcut(.defaultAction)
        .buttonStyle(.borderedProminent)
      }
    }
    .padding(20)
    .frame(width: 400)
    .background(Color(NSColor.windowBackgroundColor))
    .cornerRadius(12)
    .shadow(color: .black.opacity(0.2), radius: 10, x: 0, y: 5)
    .scaleEffect(isVisible ? 1.0 : 0.8)
    .opacity(isVisible ? 1.0 : 0.0)
    .onAppear {
      withAnimation {
        isVisible = true
      }
    }
  }
}

#Preview {
  let sampleFiles = [
    X3FFile(url: URL(fileURLWithPath: "/Users/test/Documents/IMG_001.X3F")),
    X3FFile(url: URL(fileURLWithPath: "/Users/test/Documents/IMG_002.X3F")),
  ]

  ReconversionConfirmationView(
    conflictingFiles: sampleFiles,
    onConfirm: {},
    onCancel: {}
  )
}
