package io.streamlift.tv.ui.player

import android.app.Application
import android.net.Uri
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import io.streamlift.tv.BuildConfig
import io.streamlift.tv.data.ApiException
import io.streamlift.tv.data.AppContainer
import io.streamlift.tv.data.ChapterInfo
import io.streamlift.tv.data.MediaTicket
import io.streamlift.tv.data.PlayerItem
import io.streamlift.tv.data.ResumeEntry
import io.streamlift.tv.data.WorkerConnection
import io.streamlift.tv.util.PlaybackUrls
import io.streamlift.tv.util.cleanMediaTitle
import java.util.Locale
import kotlin.math.roundToInt
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

enum class PlaybackStatus {
    Preparing,
    Ready,
    Error,
}

data class TrackChoice(
    val id: String,
    val label: String,
    val detail: String? = null,
    val groupIndex: Int,
    val trackIndex: Int,
    val sortValue: Int = 0,
)

data class PlayerUiState(
    val title: String = "",
    val workerName: String = "",
    val status: PlaybackStatus = PlaybackStatus.Preparing,
    val error: String? = null,
    val isPlaying: Boolean = false,
    val positionMs: Long = 0L,
    val durationMs: Long = 0L,
    val bufferedMs: Long = 0L,
    val playbackState: Int = Player.STATE_IDLE,
    val audioTracks: List<TrackChoice> = emptyList(),
    val subtitleTracks: List<TrackChoice> = emptyList(),
    val qualityTracks: List<TrackChoice> = emptyList(),
    val chapters: List<ChapterInfo> = emptyList(),
    val selectedAudioId: String? = null,
    val selectedSubtitleId: String? = null,
    val selectedQualityId: String? = null,
    val playbackSpeed: Float = 1f,
    val sourceHeight: Int? = null,
    val targetHeight: Int? = null,
    val showResumePrompt: Boolean = false,
    val resumePositionMs: Long = 0L,
    val resumeDurationMs: Long = 0L,
    val currentIndex: Int = 0,
    val hasNext: Boolean = false,
    val hasPrevious: Boolean = false,
)

@OptIn(UnstableApi::class)
class PlayerViewModel(
    application: Application,
    private val container: AppContainer,
    private val items: List<PlayerItem>,
    startIndex: Int,
) : AndroidViewModel(application) {
    private val api = container.api
    private val workerApi = container.workerApi
    private val resumeStore = container.resumeStore

    private val _state = kotlinx.coroutines.flow.MutableStateFlow(
        PlayerUiState(
            currentIndex = startIndex.coerceIn(0, (items.size - 1).coerceAtLeast(0)),
            hasNext = startIndex < items.lastIndex,
            hasPrevious = startIndex > 0,
        ),
    )
    val state: kotlinx.coroutines.flow.StateFlow<PlayerUiState> = _state

    private var currentIndex = startIndex.coerceIn(0, (items.size - 1).coerceAtLeast(0))
    private var loadJob: Job? = null
    private var lastSavedAt = 0L

    private val httpDataSourceFactory = DefaultHttpDataSource.Factory()
        .setAllowCrossProtocolRedirects(true)
        .setConnectTimeoutMs(15_000)
        .setReadTimeoutMs(30_000)
        .setUserAgent("StreamLiftTV/${BuildConfig.VERSION_NAME}")
        .setDefaultRequestProperties(
            mapOf("User-Agent" to "StreamLiftTV/${BuildConfig.VERSION_NAME}"),
        )

    val player: ExoPlayer = ExoPlayer.Builder(application)
        .setMediaSourceFactory(DefaultMediaSourceFactory(httpDataSourceFactory))
        .setLoadControl(
            DefaultLoadControl.Builder()
                .setBufferDurationsMs(
                    15_000,
                    60_000,
                    1_500,
                    3_000,
                )
                .build(),
        )
        .setAudioAttributes(
            AudioAttributes.Builder()
                .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                .setUsage(C.USAGE_MEDIA)
                .build(),
            true,
        )
        .setHandleAudioBecomingNoisy(true)
        .build()

    private val listener = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            val expectedId = items.getOrNull(currentIndex)?.key
            val isCurrent = player.currentMediaItem?.mediaId == expectedId
            if (isCurrent && playbackState == Player.STATE_READY) {
                _state.value = _state.value.copy(status = PlaybackStatus.Ready)
            }
            if (isCurrent && playbackState == Player.STATE_ENDED) {
                items.getOrNull(currentIndex)?.let { resumeStore.clear(it.key) }
            }
            _state.value = _state.value.copy(
                playbackState = playbackState,
                isPlaying = player.isPlaying,
                positionMs = player.currentPosition.coerceAtLeast(0L),
                durationMs = player.duration.safeDuration(),
                bufferedMs = player.bufferedPosition.coerceAtLeast(0L),
            )
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            _state.value = _state.value.copy(
                isPlaying = isPlaying,
                playbackState = player.playbackState,
            )
        }

        override fun onTracksChanged(tracks: Tracks) {
            updateTracks(tracks)
        }

        override fun onPlayerError(error: PlaybackException) {
            val expectedId = items.getOrNull(currentIndex)?.key
            if (player.currentMediaItem?.mediaId != expectedId) return

            player.pause()
            _state.value = _state.value.copy(
                status = PlaybackStatus.Error,
                error = friendlyError(error),
                isPlaying = false,
            )
        }
    }

    init {
        player.addListener(listener)
        viewModelScope.launch {
            while (currentCoroutineContext().isActive) {
                updateProgress()
                delay(500L)
            }
        }
        load(currentIndex, autoPlay = true)
    }

    fun togglePlayPause() {
        if (_state.value.status == PlaybackStatus.Error) return
        if (player.playbackState == Player.STATE_ENDED) {
            player.seekTo(0L)
            player.play()
            return
        }
        if (player.isPlaying) player.pause() else player.play()
    }

    fun seekBy(deltaMs: Long) {
        val duration = player.duration.safeDuration()
        val target = (player.currentPosition + deltaMs).coerceAtLeast(0L)
        player.seekTo(if (duration > 0L) target.coerceAtMost(duration) else target)
    }

    fun seekTo(positionMs: Long) {
        val duration = player.duration.safeDuration()
        player.seekTo(if (duration > 0L) positionMs.coerceIn(0L, duration) else positionMs.coerceAtLeast(0L))
    }

    fun playNext() {
        if (currentIndex < items.lastIndex) load(currentIndex + 1, autoPlay = true)
    }

    fun playPrevious() {
        if (currentIndex > 0) load(currentIndex - 1, autoPlay = true)
    }

    fun retry() {
        load(currentIndex, autoPlay = true)
    }

    fun setSpeed(speed: Float) {
        player.setPlaybackSpeed(speed)
        _state.value = _state.value.copy(playbackSpeed = speed)
    }

    fun selectChapter(index: Int) {
        val chapter = _state.value.chapters.getOrNull(index) ?: return
        seekTo((chapter.start * 1000.0).toLong())
        player.play()
    }

    fun resumeFromPrompt() {
        val resumePosition = _state.value.resumePositionMs
        _state.value = _state.value.copy(showResumePrompt = false)
        player.seekTo(resumePosition)
        player.play()
    }

    fun startOver() {
        _state.value = _state.value.copy(showResumePrompt = false)
        player.seekTo(0L)
        player.play()
    }

    fun dismissResumePrompt() {
        startOver()
    }

    fun selectAudio(id: String?) {
        val tracks = player.currentTracks
        val builder = player.trackSelectionParameters.buildUpon()
        if (id == null) {
            builder.clearOverridesOfType(C.TRACK_TYPE_AUDIO)
        } else {
            val (groupIndex, trackIndex) = parseChoiceId(id) ?: return
            val group = tracks.groups.getOrNull(groupIndex) ?: return
            if (group.type != C.TRACK_TYPE_AUDIO) return
            builder.setOverrideForType(
                TrackSelectionOverride(group.mediaTrackGroup, trackIndex),
            )
        }
        player.trackSelectionParameters = builder.build()
        _state.value = _state.value.copy(selectedAudioId = id)
    }

    fun selectSubtitle(id: String?) {
        val tracks = player.currentTracks
        val builder = player.trackSelectionParameters.buildUpon()
        if (id == null) {
            builder.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
            builder.clearOverridesOfType(C.TRACK_TYPE_TEXT)
        } else {
            val (groupIndex, trackIndex) = parseChoiceId(id) ?: return
            val group = tracks.groups.getOrNull(groupIndex) ?: return
            if (group.type != C.TRACK_TYPE_TEXT) return
            builder.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
            builder.setOverrideForType(
                TrackSelectionOverride(group.mediaTrackGroup, trackIndex),
            )
        }
        player.trackSelectionParameters = builder.build()
        _state.value = _state.value.copy(selectedSubtitleId = id)
    }

    fun selectQuality(id: String?) {
        val tracks = player.currentTracks
        val builder = player.trackSelectionParameters.buildUpon()
        builder.clearOverridesOfType(C.TRACK_TYPE_VIDEO)
        if (id != null) {
            val (groupIndex, trackIndex) = parseChoiceId(id) ?: return
            val group = tracks.groups.getOrNull(groupIndex) ?: return
            if (group.type != C.TRACK_TYPE_VIDEO) return
            builder.setOverrideForType(
                TrackSelectionOverride(group.mediaTrackGroup, trackIndex),
            )
        }
        player.trackSelectionParameters = builder.build()
        _state.value = _state.value.copy(selectedQualityId = id)
    }

    fun pauseAndSave() {
        runCatching { player.pause() }
        saveNow()
    }

    fun saveNow() {
        val current = _state.value
        if (current.showResumePrompt || current.status == PlaybackStatus.Error) return
        val item = items.getOrNull(currentIndex) ?: return

        val position = player.currentPosition.coerceAtLeast(0L)
        val duration = player.duration.safeDuration().takeIf { it > 0L }
            ?: current.durationMs.takeIf { it > 0L }
            ?: 0L

        if (position < 5_000L) return
        if (duration > 0L && position >= duration * 0.95) {
            resumeStore.clear(item.key)
            return
        }

        resumeStore.save(
            ResumeEntry(
                key = item.key,
                workerId = item.workerId,
                workerName = item.workerName,
                downloadId = item.downloadId,
                fileIndex = item.fileIndex,
                name = item.name,
                displayName = item.displayName,
                kind = item.kind,
                positionMs = position,
                durationMs = duration,
                updatedAt = System.currentTimeMillis(),
            ),
        )
    }

    private fun load(index: Int, autoPlay: Boolean) {
        if (items.isEmpty()) {
            _state.value = _state.value.copy(
                status = PlaybackStatus.Error,
                error = "There is nothing to play.",
            )
            return
        }

        if (index != currentIndex) saveNow()

        currentIndex = index.coerceIn(0, items.lastIndex)
        val item = items[currentIndex]
        loadJob?.cancel()

        player.pause()
        player.stop()
        player.clearMediaItems()

        _state.value = _state.value.copy(
            title = cleanMediaTitle(item.displayName),
            workerName = item.workerName,
            status = PlaybackStatus.Preparing,
            error = null,
            isPlaying = false,
            positionMs = 0L,
            durationMs = 0L,
            bufferedMs = 0L,
            playbackState = Player.STATE_IDLE,
            audioTracks = emptyList(),
            subtitleTracks = emptyList(),
            qualityTracks = emptyList(),
            chapters = emptyList(),
            selectedAudioId = null,
            selectedSubtitleId = null,
            selectedQualityId = null,
            sourceHeight = null,
            targetHeight = null,
            showResumePrompt = false,
            resumePositionMs = 0L,
            resumeDurationMs = 0L,
            currentIndex = currentIndex,
            hasNext = currentIndex < items.lastIndex,
            hasPrevious = currentIndex > 0,
        )

        loadJob = viewModelScope.launch {
            val (connection, ticket) = try {
                fetchTicket(item)
            } catch (error: Exception) {
                _state.value = _state.value.copy(
                    status = PlaybackStatus.Error,
                    error = when {
                        error is ApiException && error.statusCode == 401 ->
                            "This TV's access expired. Pair it again from Settings."
                        else -> error.message ?: "Could not prepare playback."
                    },
                )
                return@launch
            }

            val subtitleConfigurations = subtitleConfigurations(item, connection, ticket)
            val hlsUrl = PlaybackUrls.hls(
                baseUrl = connection.tunnelUrl,
                downloadId = item.downloadId,
                fileIndex = item.fileIndex,
            )

            val mediaItemBuilder = MediaItem.Builder()
                .setMediaId(item.key)
                .setUri(hlsUrl)
            if (subtitleConfigurations.isNotEmpty()) {
                mediaItemBuilder.setSubtitleConfigurations(subtitleConfigurations)
            }

            val saved = resumeStore.get(item.key)
            val hasResume = saved != null &&
                saved.positionMs >= 5_000L &&
                (saved.durationMs <= 0L || saved.positionMs < saved.durationMs * 0.95)

            _state.value = _state.value.copy(
                chapters = ticket.chapters,
                sourceHeight = ticket.height,
                targetHeight = ticket.targetHeight,
                showResumePrompt = hasResume,
                resumePositionMs = saved?.positionMs ?: 0L,
                resumeDurationMs = saved?.durationMs ?: 0L,
            )

            player.setMediaItem(mediaItemBuilder.build())
            player.prepare()

            if (hasResume) {
                player.playWhenReady = false
                player.pause()
            } else {
                player.playWhenReady = autoPlay
            }
        }
    }

    private suspend fun fetchTicket(item: PlayerItem): Pair<WorkerConnection, MediaTicket> {
        var connection = api.getWorkerConnection(item.workerId)
        // Push tunnel bypass headers to ExoPlayer's data source and Coil image
        // client so all subsequent requests use the right provider headers.
        httpDataSourceFactory.setDefaultRequestProperties(connection.tunnelHeaders)
        container.workerTunnelHeaders = connection.tunnelHeaders
        return try {
            connection to workerApi.mediaTicket(
                baseUrl = connection.tunnelUrl,
                sessionToken = connection.sessionToken,
                downloadId = item.downloadId,
                fileIndex = item.fileIndex,
                caps = PlaybackUrls.CAPS,
                tunnelHeaders = connection.tunnelHeaders,
            )
        } catch (error: ApiException) {
            if (error.statusCode != 401) throw error
            connection = api.getWorkerConnection(item.workerId, refresh = true)
            httpDataSourceFactory.setDefaultRequestProperties(connection.tunnelHeaders)
            container.workerTunnelHeaders = connection.tunnelHeaders
            connection to workerApi.mediaTicket(
                baseUrl = connection.tunnelUrl,
                sessionToken = connection.sessionToken,
                downloadId = item.downloadId,
                fileIndex = item.fileIndex,
                caps = PlaybackUrls.CAPS,
                tunnelHeaders = connection.tunnelHeaders,
            )
        }
    }

    private fun subtitleConfigurations(
        item: PlayerItem,
        connection: WorkerConnection,
        ticket: MediaTicket,
    ): List<MediaItem.SubtitleConfiguration> {
        return ticket.subtitleTracks
            .filterNot { it.bitmap }
            .map { track ->
                val label = track.title?.takeIf { it.isNotBlank() }
                    ?: track.language?.takeIf { it.isNotBlank() }?.let(::languageLabel)
                    ?: "Subtitle ${track.index + 1}"

                MediaItem.SubtitleConfiguration.Builder(
                    Uri.parse(
                        PlaybackUrls.subtitle(
                            baseUrl = connection.tunnelUrl,
                            downloadId = item.downloadId,
                            fileIndex = item.fileIndex,
                            trackIndex = track.index,
                        ),
                    ),
                )
                    .setMimeType(MimeTypes.TEXT_VTT)
                    .setLanguage(track.language)
                    .setLabel(label)
                    .setSelectionFlags(
                        (if (track.default) C.SELECTION_FLAG_DEFAULT else 0) or
                            (if (track.forced) C.SELECTION_FLAG_FORCED else 0),
                    )
                    .build()
            }
    }

    private fun updateProgress() {
        val duration = player.duration.safeDuration()
        _state.value = _state.value.copy(
            positionMs = player.currentPosition.coerceAtLeast(0L),
            durationMs = duration,
            bufferedMs = player.bufferedPosition.coerceAtLeast(0L),
            isPlaying = player.isPlaying,
            playbackState = player.playbackState,
        )

        val now = SystemClock.elapsedRealtime()
        if (now - lastSavedAt >= 5_000L) {
            lastSavedAt = now
            saveNow()
        }
    }

    private fun updateTracks(tracks: Tracks) {
        val audio = buildChoices(tracks, C.TRACK_TYPE_AUDIO)
        val text = buildChoices(tracks, C.TRACK_TYPE_TEXT)
        val video = buildChoices(tracks, C.TRACK_TYPE_VIDEO)

        _state.value = _state.value.copy(
            audioTracks = audio,
            subtitleTracks = text,
            qualityTracks = video,
            selectedAudioId = selectedIdFor(tracks, C.TRACK_TYPE_AUDIO)
                ?: _state.value.selectedAudioId,
            selectedSubtitleId = selectedIdFor(tracks, C.TRACK_TYPE_TEXT),
        )
    }

    private fun buildChoices(tracks: Tracks, type: Int): List<TrackChoice> {
        val choices = mutableListOf<TrackChoice>()

        tracks.groups.forEachIndexed { groupIndex, group ->
            if (group.type != type) return@forEachIndexed
            for (trackIndex in 0 until group.length) {
                val format = group.getTrackFormat(trackIndex)
                val choice = when (type) {
                    C.TRACK_TYPE_AUDIO -> audioChoice(format, groupIndex, trackIndex, choices.size)
                    C.TRACK_TYPE_TEXT -> textChoice(format, groupIndex, trackIndex, choices.size)
                    C.TRACK_TYPE_VIDEO -> videoChoice(format, groupIndex, trackIndex, choices.size)
                    else -> null
                }
                if (choice != null) choices.add(choice)
            }
        }

        return if (type == C.TRACK_TYPE_VIDEO) {
            choices.sortedWith(
                compareByDescending<TrackChoice> { it.sortValue }
                    .thenBy { it.label },
            )
        } else {
            choices
        }
    }

    private fun audioChoice(
        format: Format,
        groupIndex: Int,
        trackIndex: Int,
        ordinal: Int,
    ): TrackChoice {
        val label = format.label?.takeIf { it.isNotBlank() }
            ?: format.language?.let(::languageLabel)
            ?: "Audio ${ordinal + 1}"
        val detail = listOfNotNull(
            codecLabel(format),
            format.channelCount.takeIf { it > 0 }?.let { "$it ch" },
        ).joinToString(" • ").ifBlank { null }

        return TrackChoice(
            id = "$groupIndex:$trackIndex",
            label = label,
            detail = detail,
            groupIndex = groupIndex,
            trackIndex = trackIndex,
        )
    }

    private fun textChoice(
        format: Format,
        groupIndex: Int,
        trackIndex: Int,
        ordinal: Int,
    ): TrackChoice {
        val label = format.label?.takeIf { it.isNotBlank() }
            ?: format.language?.let(::languageLabel)
            ?: "Subtitle ${ordinal + 1}"
        val detail = buildList {
            format.language?.takeIf { it.isNotBlank() }
                ?.let(::languageLabel)
                ?.takeIf { it != label }
                ?.let(::add)
            if (format.selectionFlags and C.SELECTION_FLAG_FORCED != 0) add("Forced")
        }.joinToString(" • ").ifBlank { null }

        return TrackChoice(
            id = "$groupIndex:$trackIndex",
            label = label,
            detail = detail,
            groupIndex = groupIndex,
            trackIndex = trackIndex,
        )
    }

    private fun videoChoice(
        format: Format,
        groupIndex: Int,
        trackIndex: Int,
        ordinal: Int,
    ): TrackChoice {
        val height = format.height
        val label = when {
            height > 0 -> "${height}p"
            !format.label.isNullOrBlank() -> format.label!!
            else -> "Video ${ordinal + 1}"
        }
        val detail = listOfNotNull(
            format.bitrate.takeIf { it > 0 }
                ?.let { "${(it / 1_000_000.0).roundToInt()} Mbps" },
            codecLabel(format),
        ).joinToString(" • ").ifBlank { null }

        return TrackChoice(
            id = "$groupIndex:$trackIndex",
            label = label,
            detail = detail,
            groupIndex = groupIndex,
            trackIndex = trackIndex,
            sortValue = height,
        )
    }

    private fun selectedIdFor(tracks: Tracks, type: Int): String? {
        tracks.groups.forEachIndexed { groupIndex, group ->
            if (group.type != type) return@forEachIndexed
            for (trackIndex in 0 until group.length) {
                if (group.isTrackSelected(trackIndex)) {
                    return "$groupIndex:$trackIndex"
                }
            }
        }
        return null
    }

    private fun parseChoiceId(id: String): Pair<Int, Int>? {
        val parts = id.split(':')
        if (parts.size != 2) return null
        val groupIndex = parts[0].toIntOrNull() ?: return null
        val trackIndex = parts[1].toIntOrNull() ?: return null
        return groupIndex to trackIndex
    }

    private fun friendlyError(error: PlaybackException): String {
        return when (error.errorCode) {
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
            -> "Could not reach this worker. Check that it is still online."

            PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS,
            PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND,
            -> "The worker rejected playback. The file may have moved."

            PlaybackException.ERROR_CODE_DECODING_FAILED,
            PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
            PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
            -> "This TV could not decode the stream. Try another title."

            PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW -> "The stream fell behind. Try again."
            else -> error.localizedMessage ?: "Playback failed."
        }
    }

    private fun codecLabel(format: Format): String? {
        val codec = format.codecs ?: format.sampleMimeType ?: return null
        return when {
            codec.contains("avc", ignoreCase = true) ||
                codec.contains("h264", ignoreCase = true) -> "H.264"

            codec.contains("hvc", ignoreCase = true) ||
                codec.contains("hevc", ignoreCase = true) -> "H.265"

            codec.contains("av01", ignoreCase = true) -> "AV1"
            codec.contains("vp9", ignoreCase = true) -> "VP9"
            codec.contains("aac", ignoreCase = true) -> "AAC"
            codec.contains("ac-3", ignoreCase = true) ||
                codec.contains("ac3", ignoreCase = true) -> "AC-3"

            codec.contains("eac3", ignoreCase = true) -> "E-AC-3"
            codec.contains("opus", ignoreCase = true) -> "Opus"
            codec.contains("mp4a", ignoreCase = true) -> "AAC"
            else -> codec.substringBefore('.').uppercase(Locale.US)
        }
    }

    private fun languageLabel(tag: String): String {
        val normalized = when (tag.lowercase(Locale.US)) {
            "eng" -> "en"
            "spa" -> "es"
            "fre", "fra" -> "fr"
            "ger", "deu" -> "de"
            "ita" -> "it"
            "jpn" -> "ja"
            "kor" -> "ko"
            "chi", "zho" -> "zh"
            "hin" -> "hi"
            "ara" -> "ar"
            "rus" -> "ru"
            "por" -> "pt"
            "nld", "dut" -> "nl"
            "pol" -> "pl"
            "tur" -> "tr"
            "swe" -> "sv"
            "nor" -> "no"
            "dan" -> "da"
            "fin" -> "fi"
            else -> tag
        }
        val locale = Locale.forLanguageTag(normalized)
        val name = locale.displayLanguage
        return if (name.isBlank() || name.equals(normalized, ignoreCase = true)) {
            tag.uppercase(Locale.US)
        } else {
            name.replaceFirstChar { it.uppercase(locale) }
        }
    }

    private fun Long.safeDuration(): Long {
        return if (this > 0L && this != C.TIME_UNSET) this else 0L
    }

    override fun onCleared() {
        saveNow()
        player.removeListener(listener)
        player.release()
        super.onCleared()
    }

    class Factory(
        private val application: Application,
        private val container: AppContainer,
        private val items: List<PlayerItem>,
        private val startIndex: Int,
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            return PlayerViewModel(application, container, items, startIndex) as T
        }
    }
}
