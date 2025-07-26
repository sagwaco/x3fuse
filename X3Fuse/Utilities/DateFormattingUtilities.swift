//
//  DateFormattingUtilities.swift
//  X3Fuse
//
//  Created by Sang Lee on 7/21/25.
//

import Foundation

struct DateFormattingUtilities {
  
  /// Formats a date with ordinal suffix (e.g., "January 1st, 2025 at 12:00:00 PM")
  static func formatDateWithOrdinal(_ date: Date) -> String {
    let calendar = Calendar.current
    let day = calendar.component(.day, from: date)
    let ordinalSuffix = getOrdinalSuffix(for: day)

    let monthYearFormatter = DateFormatter()
    monthYearFormatter.dateFormat = "MMMM"
    let month = monthYearFormatter.string(from: date)

    let yearFormatter = DateFormatter()
    yearFormatter.dateFormat = "yyyy"
    let year = yearFormatter.string(from: date)

    let timeFormatter = DateFormatter()
    timeFormatter.dateFormat = "h:mm:ss a"
    let time = timeFormatter.string(from: date)

    return "\(month) \(day)\(ordinalSuffix), \(year) at \(time)"
  }
  
  /// Returns the appropriate ordinal suffix for a given day (st, nd, rd, th)
  private static func getOrdinalSuffix(for day: Int) -> String {
    switch day {
    case 11, 12, 13:
      return "th"
    default:
      switch day % 10 {
      case 1:
        return "st"
      case 2:
        return "nd"
      case 3:
        return "rd"
      default:
        return "th"
      }
    }
  }
}
