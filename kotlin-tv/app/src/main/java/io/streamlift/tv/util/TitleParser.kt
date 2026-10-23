package io.streamlift.tv.util

private val yearRegex = Regex("\\b(19|20)\\d{2}\\b")
private val releaseTags = Regex(
    "\\b(2160p|1080p|720p|480p|bluray|brrip|webrip|web-dl|hdtv|dvdrip|x264|x265|h264|h265|hevc|aac|ac3|dts|remux|proper|repack)\\b.*$",
    RegexOption.IGNORE_CASE,
)

fun cleanMediaTitle(raw: String): String {
    val withoutExtension = raw.substringBeforeLast('.', raw)
    val cleaned = withoutExtension
        .replace('.', ' ')
        .replace('_', ' ')
        .replace(releaseTags, "")
        .replace(Regex("\\s+"), " ")
        .trim()
    return cleaned.ifBlank { raw }
}

fun extractYear(raw: String): Int? = yearRegex.find(raw)?.value?.toIntOrNull()

fun fileExtension(raw: String): String = raw.substringAfterLast('.', "").lowercase()
