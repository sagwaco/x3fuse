import ImageIO
import QuickLookUI
import UniformTypeIdentifiers

final class PreviewProvider: QLPreviewProvider, QLPreviewingController {
    func providePreview(for request: QLFilePreviewRequest) async throws -> QLPreviewReply {
        let jpeg = try embeddedJPEG(at: request.fileURL)
        guard let source = CGImageSourceCreateWithData(jpeg as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int else {
            throw CocoaError(.fileReadCorruptFile)
        }
        // EXIF orientations 5 to 8 turn the image by 90 degrees.
        let turned = (properties[kCGImagePropertyOrientation] as? Int ?? 1) >= 5
        let size = turned ? CGSize(width: height, height: width) : CGSize(width: width, height: height)
        return QLPreviewReply(dataOfContentType: .jpeg, contentSize: size) { _ in jpeg }
    }
}
