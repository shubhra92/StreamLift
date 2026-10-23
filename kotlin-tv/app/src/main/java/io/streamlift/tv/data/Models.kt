package io.streamlift.tv.data

import kotlinx.serialization.Serializable

@Serializable
data class PairStartRequest(
    val deviceSecret: String,
    val deviceName: String? = null,
    val model: String? = null,
    val appVersion: String? = null,
)

@Serializable
data class PairStartResponse(
    val success: Boolean = false,
    val code: String = "",
    val expiresAt: String? = null,
    val expiresInMs: Long = 0,
    val pollIntervalMs: Long = 2_000,
    val serverTime: String? = null,
)

@Serializable
data class PairPollResponse(
    val success: Boolean = false,
    val status: String = "",
    val expiresAt: String? = null,
    val deviceToken: String? = null,
    val device: PairDevice? = null,
    val message: String? = null,
)

@Serializable
data class PairDevice(
    val id: String = "",
    val name: String = "",
)

@Serializable
data class MeResponse(
    val success: Boolean = false,
    val device: DeviceInfo = DeviceInfo(),
    val guest: GuestInfo? = null,
    val serverTime: String? = null,
)

@Serializable
data class DeviceInfo(
    val id: String = "",
    val name: String = "",
    val model: String? = null,
    val appVersion: String? = null,
    val online: Boolean = false,
    val lastSeenAt: String? = null,
    val createdAt: String? = null,
)

@Serializable
data class GuestInfo(
    val expiresAt: String? = null,
)

@Serializable
data class CatalogResponse(
    val success: Boolean = false,
    val generatedAt: String? = null,
    val groups: List<CatalogGroup> = emptyList(),
    val unreachableWorkers: List<UnreachableWorker> = emptyList(),
    val totals: CatalogTotals? = null,
)

@Serializable
data class CatalogGroup(
    val worker: CatalogWorker = CatalogWorker(),
    val files: List<CatalogFile> = emptyList(),
)

@Serializable
data class CatalogWorker(
    val id: String = "",
    val name: String = "",
    val countryCode: String? = null,
    val online: Boolean = true,
    val lastHeartbeat: String? = null,
)

@Serializable
data class CatalogFile(
    val key: String = "",
    val downloadId: String = "",
    val fileIndex: Int = 0,
    val name: String = "",
    val downloadName: String = "",
    val size: Long = 0,
    val kind: String = "video",
    val addedAt: String? = null,
    val thumbnailUrl: String? = null,
) {
    val isAudio: Boolean get() = kind == "audio"
    val displayName: String get() = downloadName.ifBlank { name }
}

@Serializable
data class UnreachableWorker(
    val workerId: String = "",
    val name: String = "",
    val message: String = "",
)

@Serializable
data class CatalogTotals(
    val workers: Int = 0,
    val files: Int = 0,
)

@Serializable
data class WorkerConnection(
    val success: Boolean = false,
    val workerId: String = "",
    val workerName: String = "",
    val pinggyUrl: String = "",
    val sessionToken: String = "",
)

@Serializable
data class MediaTicket(
    val mode: String? = null,
    val state: String? = null,
    val progress: Double = 0.0,
    val detail: String? = null,
    val speed: Double? = null,
    val height: Int? = null,
    val targetHeight: Int? = null,
    val encoder: String? = null,
    val multiAudio: Boolean = false,
    val audioTracks: List<AudioTrackInfo> = emptyList(),
    val subtitleTracks: List<SubtitleTrackInfo> = emptyList(),
    val chapters: List<ChapterInfo> = emptyList(),
    val token: String? = null,
)

@Serializable
data class AudioTrackInfo(
    val index: Int = 0,
    val streamIndex: Int? = null,
    val codec: String? = null,
    val channels: Int? = null,
    val language: String? = null,
    val title: String? = null,
    val default: Boolean = false,
)

@Serializable
data class SubtitleTrackInfo(
    val index: Int = 0,
    val streamIndex: Int? = null,
    val codec: String? = null,
    val language: String? = null,
    val title: String? = null,
    val default: Boolean = false,
    val forced: Boolean = false,
    val bitmap: Boolean = false,
)

@Serializable
data class ChapterInfo(
    val start: Double = 0.0,
    val end: Double? = null,
    val title: String = "",
)

@Serializable
data class PlayerItem(
    val key: String,
    val workerId: String,
    val workerName: String,
    val downloadId: String,
    val fileIndex: Int,
    val name: String,
    val displayName: String,
    val kind: String,
    val size: Long = 0,
)

fun CatalogFile.toPlayerItem(worker: CatalogWorker): PlayerItem = PlayerItem(
    key = key,
    workerId = worker.id,
    workerName = worker.name,
    downloadId = downloadId,
    fileIndex = fileIndex,
    name = name,
    displayName = displayName,
    kind = kind,
    size = size,
)
