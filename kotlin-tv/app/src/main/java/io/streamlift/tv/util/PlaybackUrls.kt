package io.streamlift.tv.util

import android.net.Uri

object PlaybackUrls {
    /** The worker outputs H.264 video + AAC stereo audio on the HLS path. */
    const val CAPS = "h264|aac"

    fun hls(baseUrl: String, downloadId: String, fileIndex: Int): String {
        return "${baseUrl.trimEnd('/')}/watch/${Uri.encode(downloadId)}/$fileIndex/index.m3u8" +
            "?caps=${Uri.encode(CAPS)}"
    }

    fun subtitle(baseUrl: String, downloadId: String, fileIndex: Int, trackIndex: Int): String {
        return "${baseUrl.trimEnd('/')}/downloads/${Uri.encode(downloadId)}/files/$fileIndex/" +
            "subtitles/$trackIndex.vtt?caps=${Uri.encode(CAPS)}"
    }
}
