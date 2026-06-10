/**
 * Presentation formatters ported from the Swift app:
 *   - formatDateWithOrdinal  <- DateFormattingUtilities.formatDateWithOrdinal
 *   - formatBytes            <- ByteCountFormatter(countStyle: .file)
 */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

function ordinalSuffix(day: number): string {
  if (day === 11 || day === 12 || day === 13) return 'th'
  switch (day % 10) {
    case 1:
      return 'st'
    case 2:
      return 'nd'
    case 3:
      return 'rd'
    default:
      return 'th'
  }
}

/** e.g. "January 1st, 2025 at 12:00:00 PM" (matches the macOS app). */
export function formatDateWithOrdinal(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const month = MONTHS[d.getMonth()]
  const day = d.getDate()
  const year = d.getFullYear()

  let hour = d.getHours()
  const ampm = hour >= 12 ? 'PM' : 'AM'
  hour = hour % 12
  if (hour === 0) hour = 12
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')

  return `${month} ${day}${ordinalSuffix(day)}, ${year} at ${hour}:${mm}:${ss} ${ampm}`
}

const BYTE_UNITS = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB']

/** Approximates macOS ByteCountFormatter(.file): SI (1000) units, ≤1 decimal. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} bytes`
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${BYTE_UNITS[unit]}`
}
