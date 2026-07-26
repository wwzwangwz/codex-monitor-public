package com.codexmonitor.mobile

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Base64
import java.io.ByteArrayOutputStream

object GuidanceImages {
    const val MAX_IMAGES = 10
    const val MAX_IMAGE_BYTES = 4 * 1024 * 1024
    const val MAX_TOTAL_BYTES = 24 * 1024 * 1024
    private const val MAX_DIMENSION = 2048

    fun prepare(context: Context, uris: List<Uri>): List<GuidanceAttachment> {
        require(uris.size <= MAX_IMAGES) { "最多选择 $MAX_IMAGES 张图片" }
        var total = 0
        return uris.mapIndexed { index, uri ->
            val bitmap = decode(context, uri)
            val scaled = scale(bitmap)
            if (scaled !== bitmap) bitmap.recycle()
            val bytes = compress(scaled)
            scaled.recycle()
            require(bytes.size <= MAX_IMAGE_BYTES) { "第 ${index + 1} 张图片压缩后仍超过 4 MiB" }
            total += bytes.size
            require(total <= MAX_TOTAL_BYTES) { "图片总大小不能超过 24 MiB" }
            GuidanceAttachment(
                name = displayName(context, uri, index),
                mimeType = "image/jpeg",
                sizeBytes = bytes.size,
                dataBase64 = Base64.encodeToString(bytes, Base64.NO_WRAP),
            )
        }
    }

    private fun decode(context: Context, uri: Uri): Bitmap {
        val bitmap = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(context.contentResolver, uri)) { decoder, _, _ ->
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }
        } else {
            context.contentResolver.openInputStream(uri).use { input ->
                BitmapFactory.decodeStream(input)
            }
        }
        return requireNotNull(bitmap) { "无法读取所选图片" }
    }

    private fun scale(bitmap: Bitmap): Bitmap {
        val longest = maxOf(bitmap.width, bitmap.height)
        if (longest <= MAX_DIMENSION) return bitmap
        val ratio = MAX_DIMENSION.toFloat() / longest
        return Bitmap.createScaledBitmap(
            bitmap,
            (bitmap.width * ratio).toInt().coerceAtLeast(1),
            (bitmap.height * ratio).toInt().coerceAtLeast(1),
            true,
        )
    }

    private fun compress(bitmap: Bitmap): ByteArray {
        var quality = 88
        var bytes: ByteArray
        do {
            val output = ByteArrayOutputStream()
            check(bitmap.compress(Bitmap.CompressFormat.JPEG, quality, output)) { "图片压缩失败" }
            bytes = output.toByteArray()
            quality -= 10
        } while (bytes.size > MAX_IMAGE_BYTES && quality >= 48)
        return bytes
    }

    private fun displayName(context: Context, uri: Uri, index: Int): String {
        val original = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            cursor.takeIf { it.moveToFirst() }?.getString(0)
        }
        val stem = original?.substringBeforeLast('.')?.replace(Regex("[^A-Za-z0-9._-]"), "_")
            ?.take(80)?.ifBlank { null } ?: "screenshot-${index + 1}"
        return "$stem.jpg"
    }
}
