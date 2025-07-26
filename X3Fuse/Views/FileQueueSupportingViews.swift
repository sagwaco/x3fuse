//
//  FileQueueSupportingViews.swift
//  X3Fuse
//
//  Created by Sang Lee on 7/21/25.
//

import SwiftUI

struct StatusBadge: View {
  let count: Int
  let label: String
  let color: Color

  var body: some View {
    HStack(spacing: 4) {
      Text("\(count)")
        .font(.caption.weight(.semibold))
        .foregroundColor(color)
      Text(label)
        .font(.caption)
        .foregroundColor(.secondary)
    }
  }
}
