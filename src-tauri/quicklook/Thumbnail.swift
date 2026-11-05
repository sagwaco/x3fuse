import ImageIO
import QuickLookThumbnailing

final class ThumbnailProvider: QLThumbnailProvider {
    override func provideThumbnail(
        for request: QLFileThumbnailRequest, _ handler: @escaping (QLThumbnailReply?, Error?) -> Void
    ) {
        do {
            let jpeg = try embeddedJPEG(at: request.fileURL)
            let maxSize = request.maximumSize
            let options = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: max(maxSize.width, maxSize.height) * request.scale,
            ] as CFDictionary
            guard let source = CGImageSourceCreateWithData(jpeg as CFData, nil),
                  let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else {
                throw CocoaError(.fileReadCorruptFile)
            }
            let fit = min(maxSize.width / CGFloat(image.width), maxSize.height / CGFloat(image.height))
            let size = CGSize(width: CGFloat(image.width) * fit, height: CGFloat(image.height) * fit)
            handler(QLThumbnailReply(contextSize: size) { context in
                // The context is in pixels, so fill its bounds, not the size in points.
                context.draw(image, in: context.boundingBoxOfClipPath)
                return true
            }, nil)
        } catch {
            handler(nil, error)
        }
    }
}
