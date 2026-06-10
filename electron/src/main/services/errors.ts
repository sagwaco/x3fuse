/** Port of Swift `ProcessingError` (FileProcessor.swift:315). */
export type ConversionErrorKind =
  | 'missingBinary'
  | 'conversionFailed'
  | 'conversionCancelled'
  | 'missingOutputFile'
  | 'invalidOutputFile'
  | 'validationFailed'
  | 'exifProcessingFailed'

export class ConversionError extends Error {
  constructor(
    public readonly kind: ConversionErrorKind,
    message: string
  ) {
    super(message)
    this.name = 'ConversionError'
  }
}

export function isCancellation(e: unknown): boolean {
  return e instanceof ConversionError && e.kind === 'conversionCancelled'
}
