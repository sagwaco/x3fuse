//
//  ExifEditorView.swift
//  X3Fuse
//
//  Created by Sang Lee on 7/8/25.
//

import SwiftUI

struct ExifEditorView: View {
  let files: [X3FFile]

  @State private var queue = ConversionQueue.shared
  @State private var exifService = ExifService.shared

  // Editable EXIF fields
  @State private var cameraModel: String = ""
  @State private var aperture: String = ""
  @State private var lensId: String = ""

  // UI state
  @State private var isEditing = false
  @State private var hasChanges = false

  var body: some View {
    VStack(spacing: 0) {
      // Header
      headerView

      Divider()

      // Content
      if files.count == 1 {
        singleFileEditor
      } else {
        multiFileEditor
      }

      Spacer()

      Divider()

      // Footer with undo/redo controls
      footerView
    }
    .onAppear {
      loadExifData()
    }
    .onChange(of: files.count) { _, _ in
      loadExifData()
    }
  }

  // MARK: - Header View

  private var headerView: some View {
    HStack {
      VStack(alignment: .leading) {
        Text("EXIF Editor")
          .font(.title2)
          .fontWeight(.semibold)

        Text(files.count == 1 ? files[0].fileName : "\(files.count) files selected")
          .font(.caption)
          .foregroundColor(.secondary)
      }

      Spacer()

      HStack(spacing: 8) {
        if isEditing {
          Button("Cancel") {
            cancelEditing()
          }
          .buttonStyle(.bordered)

          Button("Save") {
            saveChanges()
          }
          .buttonStyle(.borderedProminent)
          .disabled(!hasChanges)
        } else {
          Button("Edit") {
            startEditing()
          }
          .buttonStyle(.bordered)
        }
      }
    }
    .padding()
  }

  // MARK: - Single File Editor

  private var singleFileEditor: some View {
    let file = files[0]

    return ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        // Basic EXIF fields
        exifSection("Camera Information") {
          exifField("Camera Model", value: $cameraModel, isEditing: isEditing)
          exifField("Aperture", value: $aperture, isEditing: isEditing)
          exifField("Lens ID", value: $lensId, isEditing: isEditing)
        }

        // Additional EXIF data (read-only)
        if !file.exifData.isEmpty {
          exifSection("Additional Metadata") {
            ForEach(Array(file.exifData.keys.sorted()), id: \.self) { key in
              if let value = file.exifData[key] {
                HStack {
                  Text(key)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .frame(width: 120, alignment: .leading)

                  Text("\(value)")
                    .font(.caption)
                    .foregroundColor(.primary)

                  Spacer()
                }
              }
            }
          }
        }

        // File-specific conversion settings
        conversionSettingsSection(for: file)
      }
      .padding()
    }
  }

  // MARK: - Multi File Editor

  private var multiFileEditor: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        // Bulk edit section
        exifSection("Bulk Edit") {
          Text("Changes will be applied to all \(files.count) selected files")
            .font(.caption)
            .foregroundColor(.secondary)
            .padding(.bottom, 8)

          exifField("Camera Model", value: $cameraModel, isEditing: isEditing)
          exifField("Aperture", value: $aperture, isEditing: isEditing)
          exifField("Lens ID", value: $lensId, isEditing: isEditing)
        }

        // File list with individual values
        exifSection("Individual Files") {
          ForEach(files) { file in
            VStack(alignment: .leading, spacing: 4) {
              Text(file.fileName)
                .font(.caption)
                .fontWeight(.medium)

              HStack {
                Text("Model: \(file.cameraModel ?? "Unknown")")
                  .font(.caption)
                  .foregroundColor(.secondary)

                Spacer()

                Text("f/\(file.aperture ?? "?")")
                  .font(.caption)
                  .foregroundColor(.secondary)
              }
            }
            .padding(.vertical, 2)

            if file.id != files.last?.id {
              Divider()
            }
          }
        }
      }
      .padding()
    }
  }

  // MARK: - Helper Views

  private func exifSection<Content: View>(_ title: String, @ViewBuilder content: () -> Content)
    -> some View
  {
    VStack(alignment: .leading, spacing: 8) {
      Text(title)
        .font(.headline)
        .foregroundColor(.primary)

      VStack(alignment: .leading, spacing: 8) {
        content()
      }
      .padding()
      .background(Color(NSColor.controlBackgroundColor))
      .clipShape(RoundedRectangle(cornerRadius: 8))
    }
  }

  private func exifField(_ label: String, value: Binding<String>, isEditing: Bool) -> some View {
    HStack {
      Text(label)
        .font(.body)
        .frame(width: 120, alignment: .leading)

      if isEditing {
        TextField(label, text: value)
          .textFieldStyle(RoundedBorderTextFieldStyle())
          .onChange(of: value.wrappedValue) { _, _ in
            hasChanges = true
          }
      } else {
        Text(value.wrappedValue.isEmpty ? "Not set" : value.wrappedValue)
          .font(.body)
          .foregroundColor(value.wrappedValue.isEmpty ? .secondary : .primary)

        Spacer()
      }
    }
  }

  private func conversionSettingsSection(for file: X3FFile) -> some View {
    exifSection("Conversion Settings") {
      Text("Override global settings for this file")
        .font(.caption)
        .foregroundColor(.secondary)
        .padding(.bottom, 8)

      // TODO: Add file-specific conversion settings
      Text("File-specific settings coming soon...")
        .font(.caption)
        .foregroundColor(.secondary)
    }
  }

  // MARK: - Footer View

  private var footerView: some View {
    HStack {
      // Undo/Redo buttons
      HStack(spacing: 4) {
        Button(action: queue.undo) {
          Image(systemName: "arrow.uturn.backward")
        }
        .disabled(!queue.canUndo)
        .help("Undo")

        Button(action: queue.redo) {
          Image(systemName: "arrow.uturn.forward")
        }
        .disabled(!queue.canRedo)
        .help("Redo")
      }

      Spacer()

      // Status text
      if hasChanges {
        Text("Unsaved changes")
          .font(.caption)
          .foregroundColor(.orange)
      }
    }
    .padding()
  }

  // MARK: - Actions

  private func loadExifData() {
    guard !files.isEmpty else { return }

    if files.count == 1 {
      let file = files[0]
      cameraModel = file.cameraModel ?? ""
      aperture = file.aperture ?? ""
      lensId = file.lensId ?? ""
    } else {
      // For multiple files, show common values or empty if different
      let models = Set(files.compactMap { $0.cameraModel })
      let apertures = Set(files.compactMap { $0.aperture })
      let lensIds = Set(files.compactMap { $0.lensId })

      cameraModel = models.count == 1 ? models.first! : ""
      aperture = apertures.count == 1 ? apertures.first! : ""
      lensId = lensIds.count == 1 ? lensIds.first! : ""
    }

    hasChanges = false
  }

  private func startEditing() {
    isEditing = true
    hasChanges = false
  }

  private func cancelEditing() {
    isEditing = false
    loadExifData()  // Reset to original values
  }

  private func saveChanges() {
    // Update camera model
    if !cameraModel.isEmpty {
      queue.updateExifData(for: files, keyPath: \.cameraModel, value: cameraModel)
    }

    // Update aperture
    if !aperture.isEmpty {
      queue.updateExifData(for: files, keyPath: \.aperture, value: aperture)
    }

    // Update lens ID
    if !lensId.isEmpty {
      queue.updateExifData(for: files, keyPath: \.lensId, value: lensId)
    }

    isEditing = false
    hasChanges = false
  }
}

#Preview {
  let sampleFiles = [
    X3FFile(url: URL(fileURLWithPath: "/path/to/sample1.x3f")),
    X3FFile(url: URL(fileURLWithPath: "/path/to/sample2.x3f")),
  ]

  sampleFiles[0].cameraModel = "SIGMA DP2 Merrill"
  sampleFiles[0].aperture = "2.8"
  sampleFiles[0].lensId = "Fixed Lens"

  sampleFiles[1].cameraModel = "SIGMA DP2 Merrill"
  sampleFiles[1].aperture = "4.0"
  sampleFiles[1].lensId = "Fixed Lens"

  return ExifEditorView(files: sampleFiles)
    .frame(width: 400, height: 600)
}
