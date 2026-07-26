import Foundation
import PhotosUI
import UIKit

struct PreparedGuidanceImage: Identifiable {
    let id = UUID()
    let preview: UIImage
    let attachment: GuidanceAttachment
}

enum GuidanceImageError: LocalizedError {
    case unreadable(Int)
    case tooLarge(Int)
    case totalTooLarge

    var errorDescription: String? {
        switch self {
        case .unreadable(let index): "无法读取第 \(index) 张图片"
        case .tooLarge(let index): "第 \(index) 张图片压缩后仍超过 4 MiB"
        case .totalTooLarge: "图片总大小不能超过 24 MiB"
        }
    }
}

@MainActor
enum GuidanceImagePreparer {
    static let maxImages = 10
    private static let maxImageBytes = 4 * 1024 * 1024
    private static let maxTotalBytes = 24 * 1024 * 1024
    private static let maxDimension: CGFloat = 2048

    static func prepare(_ items: [PhotosPickerItem]) async throws -> [PreparedGuidanceImage] {
        var total = 0
        var results: [PreparedGuidanceImage] = []
        for (offset, item) in items.prefix(maxImages).enumerated() {
            let index = offset + 1
            guard let source = try await item.loadTransferable(type: Data.self),
                  let image = UIImage(data: source) else {
                throw GuidanceImageError.unreadable(index)
            }
            let normalized = resize(image)
            guard let encoded = compress(normalized) else {
                throw GuidanceImageError.tooLarge(index)
            }
            total += encoded.count
            guard total <= maxTotalBytes else { throw GuidanceImageError.totalTooLarge }
            results.append(PreparedGuidanceImage(
                preview: normalized,
                attachment: GuidanceAttachment(
                    name: "screenshot-\(index).jpg",
                    mimeType: "image/jpeg",
                    sizeBytes: encoded.count,
                    dataBase64: encoded.base64EncodedString(),
                ),
            ))
        }
        return results
    }

    private static func resize(_ image: UIImage) -> UIImage {
        let longest = max(image.size.width, image.size.height)
        let ratio = longest > maxDimension ? maxDimension / longest : 1
        let size = CGSize(
            width: max(1, floor(image.size.width * ratio)),
            height: max(1, floor(image.size.height * ratio)),
        )
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
    }

    private static func compress(_ image: UIImage) -> Data? {
        var quality: CGFloat = 0.88
        while quality >= 0.48 {
            if let data = image.jpegData(compressionQuality: quality), data.count <= maxImageBytes {
                return data
            }
            quality -= 0.10
        }
        return nil
    }
}
