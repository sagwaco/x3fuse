//
//  DropZoneView.swift
//  X3Fuse
//
//  Created by Sang Lee on 7/8/25.
//

import SwiftUI
import UniformTypeIdentifiers

struct DropZoneView: View {
  let onFilesDropped: ([URL]) -> Void

  @State private var isDragOver = false

  var body: some View {
    VStack(spacing: 0) {
      Spacer()

      // Drop zone with dashed border - full width drop target
      HStack {
        Spacer()

        VStack(spacing: 24) {
          // X3F file icon with download arrow
          ZStack {
            // File icon background
            Image(systemName: "photo.badge.arrow.down.fill")
              .font(.system(size: 56))
              .foregroundColor(isDragOver ? .accentColor : .secondary)
              .animation(.snappy, value: isDragOver)
          }
        }
        .frame(maxWidth: 232, maxHeight: 232)
        .background(
          RoundedRectangle(cornerRadius: 12)
            .fill(Color.clear)
            .overlay(
              RoundedRectangle(cornerRadius: 12)
                .stroke(
                  isDragOver ? Color.accentColor : Color.secondary.opacity(0.4),
                  style: StrokeStyle(lineWidth: 4, dash: [12, 12])
                )
                .animation(.snappy, value: isDragOver)  // Add this line
            )
        )
        .padding(40)
        .onTapGesture {
          selectFiles()
        }

        Spacer()
      }
      .frame(maxWidth: .infinity)
      .contentShape(Rectangle())

      Spacer()
    }
    .onDrop(of: [.fileURL], isTargeted: $isDragOver) { providers in
      handleDrop(providers: providers)
    }
  }

  private func selectFiles() {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = true
    panel.canChooseDirectories = false
    panel.canChooseFiles = true
    panel.allowedContentTypes = [UTType(filenameExtension: "x3f") ?? UTType.data]
    panel.title = "Select X3F Files"
    panel.message = "Choose X3F files to convert"

    if panel.runModal() == .OK {
      onFilesDropped(panel.urls)
    }
  }

  private func handleDrop(providers: [NSItemProvider]) -> Bool {
    var urls: [URL] = []
    let group = DispatchGroup()

    for provider in providers {
      if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
        group.enter()
        provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) {
          item, error in
          defer { group.leave() }

          if let data = item as? Data,
            let url = URL(dataRepresentation: data, relativeTo: nil)
          {
            // Filter for X3F files only
            if url.pathExtension.lowercased() == "x3f" {
              urls.append(url)
            }
          }
        }
      }
    }

    group.notify(queue: .main) {
      if !urls.isEmpty {
        onFilesDropped(urls)
      }
    }

    return true
  }
}

#Preview {
  DropZoneView { urls in
    print("Dropped files: \(urls)")
  }
  .frame(width: 400, height: 300)
}
