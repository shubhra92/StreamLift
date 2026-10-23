package io.streamlift.tv.ui.player

import android.os.SystemClock
import android.util.TypedValue
import androidx.annotation.OptIn
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Audiotrack
import androidx.compose.material.icons.filled.Bookmarks
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Forward10
import androidx.compose.material.icons.filled.HighQuality
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Replay10
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material.icons.filled.Subtitles
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.CaptionStyleCompat
import androidx.media3.ui.PlayerView
import androidx.tv.foundation.lazy.list.TvLazyColumn
import androidx.tv.foundation.lazy.list.TvLazyRow
import io.streamlift.tv.ui.components.TvButton
import io.streamlift.tv.ui.components.tvFocusSurface
import io.streamlift.tv.ui.theme.StreamLiftFocusOutline
import io.streamlift.tv.ui.theme.StreamLiftFocusSecondaryText
import io.streamlift.tv.ui.theme.StreamLiftMuted
import io.streamlift.tv.ui.theme.StreamLiftSurface
import io.streamlift.tv.ui.theme.StreamLiftSurfaceVariant
import io.streamlift.tv.util.formatTime
import kotlin.math.abs
import kotlinx.coroutines.delay

private enum class PlayerMenu {
    Audio,
    Subtitles,
    Quality,
    Chapters,
    Speed,
}

@OptIn(UnstableApi::class)
@Composable
fun PlayerScreen(
    viewModel: PlayerViewModel,
    onExit: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val player = viewModel.player

    val screenFocus = remember { FocusRequester() }
    val playFocus = remember { FocusRequester() }
    var controlsVisible by remember { mutableStateOf(true) }
    var menu by remember { mutableStateOf<PlayerMenu?>(null) }
    var lastInteraction by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    var focusGuardUntil by remember {
        mutableLongStateOf(SystemClock.elapsedRealtime() + 500L)
    }

    // Only the bare video surface is focusable when playback controls are
    // hidden. While an overlay is open its own controls are the only focus
    // targets, so D-pad focus cannot escape behind the overlay.
    val rootFocusable = !controlsVisible &&
        !state.showResumePrompt &&
        menu == null &&
        state.status != PlaybackStatus.Error

    fun touch() {
        lastInteraction = SystemClock.elapsedRealtime()
    }

    // Compose can leave a focus parent active for a frame or two while an
    // overlay is being added or removed. A directional key in that window hits
    // an internal "ActiveParent must have a focusedChild" check. Consume keys
    // while focus is being handed to the new overlay, then resume normal
    // navigation.
    fun guardFocus(durationMs: Long = 250L) {
        focusGuardUntil = SystemClock.elapsedRealtime() + durationMs
    }

    LaunchedEffect(controlsVisible, menu, state.showResumePrompt, state.status) {
        guardFocus()
    }

    LaunchedEffect(controlsVisible, menu, state.showResumePrompt, state.status) {
        if (controlsVisible && menu == null && !state.showResumePrompt &&
            state.status != PlaybackStatus.Error
        ) {
            delay(90)
            runCatching { playFocus.requestFocus() }
        } else if (!controlsVisible && menu == null && !state.showResumePrompt &&
            state.status != PlaybackStatus.Error
        ) {
            runCatching { screenFocus.requestFocus() }
            delay(160)
            runCatching { screenFocus.requestFocus() }
        }
    }

    LaunchedEffect(
        controlsVisible,
        lastInteraction,
        state.isPlaying,
        menu,
        state.showResumePrompt,
        state.status,
    ) {
        if (controlsVisible && state.isPlaying && menu == null && !state.showResumePrompt &&
            state.status != PlaybackStatus.Error
        ) {
            delay(4_500)
            guardFocus()
            controlsVisible = false
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
            .focusRequester(screenFocus)
            .then(if (rootFocusable) Modifier.focusable() else Modifier)
            .onPreviewKeyEvent { event ->
                if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                touch()

                if (event.key != Key.Back && SystemClock.elapsedRealtime() < focusGuardUntil) {
                    return@onPreviewKeyEvent true
                }

                if (state.showResumePrompt) {
                    return@onPreviewKeyEvent if (event.key == Key.Back) {
                        guardFocus()
                        viewModel.dismissResumePrompt()
                        true
                    } else {
                        false
                    }
                }

                if (menu != null) {
                    return@onPreviewKeyEvent if (event.key == Key.Back) {
                        guardFocus()
                        menu = null
                        true
                    } else {
                        false
                    }
                }

                if (state.status == PlaybackStatus.Error) {
                    return@onPreviewKeyEvent if (event.key == Key.Back) {
                        onExit()
                        true
                    } else {
                        false
                    }
                }

                if (!controlsVisible) {
                    return@onPreviewKeyEvent when (event.key) {
                        Key.DirectionCenter, Key.Enter -> {
                            viewModel.togglePlayPause()
                            guardFocus()
                            controlsVisible = true
                            true
                        }

                        Key.DirectionLeft, Key.MediaRewind -> {
                            viewModel.seekBy(-10_000L)
                            guardFocus()
                            controlsVisible = true
                            true
                        }

                        Key.DirectionRight, Key.MediaFastForward -> {
                            viewModel.seekBy(10_000L)
                            guardFocus()
                            controlsVisible = true
                            true
                        }

                        Key.DirectionUp, Key.DirectionDown -> {
                            guardFocus()
                            controlsVisible = true
                            true
                        }

                        Key.MediaPlayPause -> {
                            viewModel.togglePlayPause()
                            true
                        }

                        Key.MediaNext -> {
                            viewModel.playNext()
                            true
                        }

                        Key.MediaPrevious -> {
                            viewModel.playPrevious()
                            true
                        }

                        Key.Back -> {
                            onExit()
                            true
                        }

                        else -> false
                    }
                }

                when (event.key) {
                    Key.Back -> {
                        guardFocus()
                        controlsVisible = false
                        true
                    }

                    Key.MediaPlayPause -> {
                        viewModel.togglePlayPause()
                        true
                    }

                    Key.MediaNext -> {
                        viewModel.playNext()
                        true
                    }

                    Key.MediaPrevious -> {
                        viewModel.playPrevious()
                        true
                    }

                    Key.DirectionUp -> {
                        guardFocus()
                        controlsVisible = false
                        true
                    }

                    else -> false
                }
            },
    ) {
        VideoSurface(
            player = player,
            modifier = Modifier.fillMaxSize(),
        )

        AnimatedVisibility(
            visible = controlsVisible && !state.showResumePrompt &&
                menu == null && state.status != PlaybackStatus.Error,
            enter = fadeIn(),
            exit = fadeOut(),
            modifier = Modifier.fillMaxSize(),
        ) {
            PlayerControls(
                state = state,
                playFocus = playFocus,
                onPlayPause = {
                    touch()
                    viewModel.togglePlayPause()
                },
                onSeekBack = {
                    touch()
                    viewModel.seekBy(-10_000L)
                },
                onSeekForward = {
                    touch()
                    viewModel.seekBy(10_000L)
                },
                onNext = {
                    touch()
                    viewModel.playNext()
                },
                onPrevious = {
                    touch()
                    viewModel.playPrevious()
                },
                onAudio = {
                    touch()
                    guardFocus()
                    menu = PlayerMenu.Audio
                },
                onSubtitles = {
                    touch()
                    guardFocus()
                    menu = PlayerMenu.Subtitles
                },
                onQuality = {
                    touch()
                    guardFocus()
                    menu = PlayerMenu.Quality
                },
                onChapters = {
                    touch()
                    guardFocus()
                    menu = PlayerMenu.Chapters
                },
                onSpeed = {
                    touch()
                    guardFocus()
                    menu = PlayerMenu.Speed
                },
            )
        }

        if (
            state.status == PlaybackStatus.Preparing ||
            (state.status == PlaybackStatus.Ready &&
                state.playbackState == Player.STATE_BUFFERING &&
                !state.showResumePrompt)
        ) {
            BufferingOverlay(
                preparing = state.status == PlaybackStatus.Preparing,
                title = state.title,
            )
        }

        if (state.showResumePrompt) {
            ResumePrompt(
                state = state,
                onResume = {
                    touch()
                    guardFocus()
                    viewModel.resumeFromPrompt()
                },
                onStartOver = {
                    touch()
                    guardFocus()
                    viewModel.startOver()
                },
            )
        }

        if (state.status == PlaybackStatus.Error) {
            ErrorOverlay(
                message = state.error,
                onRetry = {
                    touch()
                    guardFocus()
                    viewModel.retry()
                },
                onExit = onExit,
            )
        }

        menu?.let { activeMenu ->
            PlayerMenuOverlay(
                menu = activeMenu,
                state = state,
                onSelect = { selectedMenu, id ->
                    touch()
                    guardFocus()
                    when (selectedMenu) {
                        PlayerMenu.Audio -> viewModel.selectAudio(id)
                        PlayerMenu.Subtitles -> viewModel.selectSubtitle(id)
                        PlayerMenu.Quality -> viewModel.selectQuality(id)
                        PlayerMenu.Chapters -> id?.toIntOrNull()?.let(viewModel::selectChapter)
                        PlayerMenu.Speed -> id?.toFloatOrNull()?.let(viewModel::setSpeed)
                    }
                    menu = null
                },
                onDismiss = {
                    touch()
                    guardFocus()
                    menu = null
                },
            )
        }
    }
}

@OptIn(UnstableApi::class)
@Composable
private fun VideoSurface(
    player: ExoPlayer,
    modifier: Modifier = Modifier,
) {
    AndroidView(
        factory = { context ->
            PlayerView(context).apply {
                useController = false
                resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                setShutterBackgroundColor(android.graphics.Color.BLACK)
                setShowBuffering(PlayerView.SHOW_BUFFERING_NEVER)
                subtitleView?.apply {
                    setApplyEmbeddedStyles(false)
                    setApplyEmbeddedFontSizes(false)
                    setFixedTextSize(TypedValue.COMPLEX_UNIT_SP, 26f)
                    setBottomPaddingFraction(0.09f)
                    setStyle(
                        CaptionStyleCompat(
                            android.graphics.Color.WHITE,
                            android.graphics.Color.TRANSPARENT,
                            android.graphics.Color.TRANSPARENT,
                            CaptionStyleCompat.EDGE_TYPE_OUTLINE,
                            android.graphics.Color.BLACK,
                            null,
                        ),
                    )
                }
            }
        },
        update = { view ->
            view.player = player
        },
        modifier = modifier,
    )
}

@Composable
private fun PlayerControls(
    state: PlayerUiState,
    playFocus: FocusRequester,
    onPlayPause: () -> Unit,
    onSeekBack: () -> Unit,
    onSeekForward: () -> Unit,
    onNext: () -> Unit,
    onPrevious: () -> Unit,
    onAudio: () -> Unit,
    onSubtitles: () -> Unit,
    onQuality: () -> Unit,
    onChapters: () -> Unit,
    onSpeed: () -> Unit,
) {
    Box(modifier = Modifier.fillMaxSize()) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(
                    Brush.verticalGradient(
                        colorStops = arrayOf(
                            0f to Color.Black.copy(alpha = 0.82f),
                            0.28f to Color.Transparent,
                            0.58f to Color.Transparent,
                            1f to Color.Black.copy(alpha = 0.9f),
                        ),
                    ),
                ),
        )

        Column(modifier = Modifier.fillMaxSize()) {
            PlayerTopBar(state = state)
            Spacer(Modifier.weight(1f))
            PlayerBottomBar(
                state = state,
                playFocus = playFocus,
                onPlayPause = onPlayPause,
                onSeekBack = onSeekBack,
                onSeekForward = onSeekForward,
                onNext = onNext,
                onPrevious = onPrevious,
                onAudio = onAudio,
                onSubtitles = onSubtitles,
                onQuality = onQuality,
                onChapters = onChapters,
                onSpeed = onSpeed,
            )
        }
    }
}

@Composable
private fun PlayerTopBar(state: PlayerUiState) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 48.dp, vertical = 34.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = state.title,
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.SemiBold,
                color = Color.White,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text = listOfNotNull(
                    state.workerName.takeIf { it.isNotBlank() },
                    qualityLabel(state),
                ).joinToString("  •  "),
                style = MaterialTheme.typography.bodyMedium,
                color = Color.White.copy(alpha = 0.65f),
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun PlayerBottomBar(
    state: PlayerUiState,
    playFocus: FocusRequester,
    onPlayPause: () -> Unit,
    onSeekBack: () -> Unit,
    onSeekForward: () -> Unit,
    onNext: () -> Unit,
    onPrevious: () -> Unit,
    onAudio: () -> Unit,
    onSubtitles: () -> Unit,
    onQuality: () -> Unit,
    onChapters: () -> Unit,
    onSpeed: () -> Unit,
) {
    val actions = listOf(
        PlayerAction(
            icon = Icons.Filled.SkipPrevious,
            label = "Previous",
            enabled = state.hasPrevious,
            onClick = onPrevious,
        ),
        PlayerAction(
            icon = Icons.Filled.Replay10,
            label = "10 sec",
            onClick = onSeekBack,
        ),
        PlayerAction(
            icon = if (state.isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow,
            label = if (state.isPlaying) "Pause" else "Play",
            onClick = onPlayPause,
            focusRequester = playFocus,
        ),
        PlayerAction(
            icon = Icons.Filled.Forward10,
            label = "10 sec",
            onClick = onSeekForward,
        ),
        PlayerAction(
            icon = Icons.Filled.SkipNext,
            label = "Next",
            enabled = state.hasNext,
            onClick = onNext,
        ),
        PlayerAction(
            icon = Icons.Filled.Audiotrack,
            label = "Audio",
            enabled = state.audioTracks.size > 1,
            onClick = onAudio,
        ),
        PlayerAction(
            icon = Icons.Filled.Subtitles,
            label = "Subtitles",
            enabled = state.subtitleTracks.isNotEmpty(),
            onClick = onSubtitles,
        ),
        PlayerAction(
            icon = Icons.Filled.HighQuality,
            label = "Quality",
            enabled = state.qualityTracks.size > 1,
            onClick = onQuality,
        ),
        PlayerAction(
            icon = Icons.Filled.Bookmarks,
            label = "Chapters",
            enabled = state.chapters.isNotEmpty(),
            onClick = onChapters,
        ),
        PlayerAction(
            icon = Icons.Filled.Speed,
            label = speedLabel(state.playbackSpeed),
            onClick = onSpeed,
        ),
    )

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 48.dp)
            .padding(bottom = 38.dp),
    ) {
        Timeline(state = state)
        Spacer(Modifier.height(18.dp))
        TvLazyRow(
            contentPadding = PaddingValues(0.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(count = actions.size, key = { index -> index.toString() }) { index ->
                val action = actions[index]
                TvButton(
                    text = action.label,
                    icon = action.icon,
                    compact = true,
                    enabled = action.enabled,
                    onClick = action.onClick,
                    focusRequester = action.focusRequester,
                )
            }
        }
    }
}

private data class PlayerAction(
    val icon: ImageVector,
    val label: String,
    val enabled: Boolean = true,
    val onClick: () -> Unit,
    val focusRequester: FocusRequester? = null,
)

@Composable
private fun Timeline(state: PlayerUiState) {
    val duration = state.durationMs.coerceAtLeast(1L)
    val progress = (state.positionMs.toFloat() / duration.toFloat()).coerceIn(0f, 1f)
    val buffered = (state.bufferedMs.toFloat() / duration.toFloat()).coerceIn(0f, 1f)
    val accent = MaterialTheme.colorScheme.primary

    Column(modifier = Modifier.fillMaxWidth()) {
        Canvas(
            modifier = Modifier
                .fillMaxWidth()
                .height(12.dp),
        ) {
            val trackHeight = size.height
            val radius = CornerRadius(trackHeight / 2f)
            drawRoundRect(
                color = Color.White.copy(alpha = 0.18f),
                size = Size(size.width, trackHeight),
                cornerRadius = radius,
            )
            if (buffered > 0f) {
                drawRoundRect(
                    color = Color.White.copy(alpha = 0.32f),
                    size = Size(size.width * buffered, trackHeight),
                    cornerRadius = radius,
                )
            }
            if (progress > 0f) {
                drawRoundRect(
                    color = accent,
                    size = Size(size.width * progress, trackHeight),
                    cornerRadius = radius,
                )
            }

            state.chapters.forEach { chapter ->
                val fraction = ((chapter.start * 1000.0) / duration.toDouble())
                    .toFloat()
                    .coerceIn(0f, 1f)
                val x = size.width * fraction
                drawLine(
                    color = Color.White.copy(alpha = 0.55f),
                    start = Offset(x, 0f),
                    end = Offset(x, trackHeight),
                    strokeWidth = 2f,
                )
            }

            drawCircle(
                color = accent,
                radius = trackHeight * 0.9f,
                center = Offset(size.width * progress, trackHeight / 2f),
            )
        }
        Spacer(Modifier.height(4.dp))
        Row(modifier = Modifier.fillMaxWidth()) {
            Text(
                text = formatTime(state.positionMs),
                style = MaterialTheme.typography.labelMedium,
                color = Color.White.copy(alpha = 0.7f),
            )
            Spacer(Modifier.weight(1f))
            Text(
                text = formatTime(state.durationMs),
                style = MaterialTheme.typography.labelMedium,
                color = Color.White.copy(alpha = 0.7f),
            )
        }
    }
}

@Composable
private fun BufferingOverlay(preparing: Boolean, title: String) {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(18.dp))
                .background(Color.Black.copy(alpha = 0.68f))
                .padding(horizontal = 24.dp, vertical = 18.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            CircularProgressIndicator(
                color = MaterialTheme.colorScheme.primary,
                strokeWidth = 3.dp,
                modifier = Modifier.size(28.dp),
            )
            Column {
                Text(
                    text = if (preparing) "Preparing playback…" else "Buffering…",
                    style = MaterialTheme.typography.titleMedium,
                    color = Color.White,
                )
                if (preparing && title.isNotBlank()) {
                    Text(
                        text = title,
                        style = MaterialTheme.typography.bodyMedium,
                        color = Color.White.copy(alpha = 0.6f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@Composable
private fun ResumePrompt(
    state: PlayerUiState,
    onResume: () -> Unit,
    onStartOver: () -> Unit,
) {
    val resumeFocus = remember { FocusRequester() }

    LaunchedEffect(Unit) {
        delay(120)
        runCatching { resumeFocus.requestFocus() }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.72f)),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = 620.dp)
                .clip(RoundedCornerShape(22.dp))
                .background(StreamLiftSurface)
                .padding(32.dp),
        ) {
            Text(
                text = "Continue watching?",
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Spacer(Modifier.height(10.dp))
            Text(
                text = state.title,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(10.dp))
            Text(
                text = "You stopped at ${formatTime(state.resumePositionMs)}" +
                    if (state.resumeDurationMs > 0L) {
                        " of ${formatTime(state.resumeDurationMs)}."
                    } else {
                        "."
                    },
                style = MaterialTheme.typography.bodyMedium,
                color = StreamLiftMuted,
            )
            Spacer(Modifier.height(26.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                TvButton(
                    text = "Resume",
                    icon = Icons.Filled.PlayArrow,
                    primary = true,
                    onClick = onResume,
                    focusRequester = resumeFocus,
                )
                TvButton(
                    text = "Start over",
                    onClick = onStartOver,
                )
            }
        }
    }
}

@Composable
private fun ErrorOverlay(
    message: String?,
    onRetry: () -> Unit,
    onExit: () -> Unit,
) {
    val retryFocus = remember { FocusRequester() }

    LaunchedEffect(Unit) {
        delay(120)
        runCatching { retryFocus.requestFocus() }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.78f)),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = 620.dp)
                .clip(RoundedCornerShape(22.dp))
                .background(StreamLiftSurface)
                .padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Icon(
                imageVector = Icons.Filled.ErrorOutline,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.error,
                modifier = Modifier.size(44.dp),
            )
            Spacer(Modifier.height(18.dp))
            Text(
                text = "Playback issue",
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Spacer(Modifier.height(10.dp))
            Text(
                text = message ?: "This title could not be played.",
                style = MaterialTheme.typography.bodyLarge,
                color = StreamLiftMuted,
            )
            Spacer(Modifier.height(26.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                TvButton(
                    text = "Try again",
                    icon = Icons.Filled.Refresh,
                    primary = true,
                    onClick = onRetry,
                    focusRequester = retryFocus,
                )
                TvButton(
                    text = "Back to library",
                    onClick = onExit,
                )
            }
        }
    }
}

private data class MenuOption(
    val id: String?,
    val label: String,
    val detail: String? = null,
    val selected: Boolean = false,
)

@Composable
private fun PlayerMenuOverlay(
    menu: PlayerMenu,
    state: PlayerUiState,
    onSelect: (PlayerMenu, String?) -> Unit,
    onDismiss: () -> Unit,
) {
    val focusRequester = remember { FocusRequester() }
    val closeFocus = remember { FocusRequester() }

    val options = when (menu) {
        PlayerMenu.Audio -> state.audioTracks.map { track ->
            MenuOption(
                id = track.id,
                label = track.label,
                detail = track.detail,
                selected = track.id == state.selectedAudioId,
            )
        }

        PlayerMenu.Subtitles -> listOf(
            MenuOption(
                id = null,
                label = "Off",
                detail = "Hide subtitles",
                selected = state.selectedSubtitleId == null,
            ),
        ) + state.subtitleTracks.map { track ->
            MenuOption(
                id = track.id,
                label = track.label,
                detail = track.detail,
                selected = track.id == state.selectedSubtitleId,
            )
        }

        PlayerMenu.Quality -> listOf(
            MenuOption(
                id = null,
                label = "Auto",
                detail = "Best available for this screen",
                selected = state.selectedQualityId == null,
            ),
        ) + state.qualityTracks.map { track ->
            MenuOption(
                id = track.id,
                label = track.label,
                detail = track.detail,
                selected = track.id == state.selectedQualityId,
            )
        }

        PlayerMenu.Chapters -> state.chapters.mapIndexed { index, chapter ->
            MenuOption(
                id = index.toString(),
                label = chapter.title.ifBlank { "Chapter ${index + 1}" },
                detail = formatTime((chapter.start * 1000.0).toLong()),
            )
        }

        PlayerMenu.Speed -> listOf(0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f).map { speed ->
            MenuOption(
                id = speed.toString(),
                label = speedLabel(speed),
                selected = abs(state.playbackSpeed - speed) < 0.01f,
            )
        }
    }

    val initialFocus = options.indexOfFirst { it.selected }.takeIf { it >= 0 } ?: 0
    val emptyMessage = when (menu) {
        PlayerMenu.Audio -> "No alternate audio tracks."
        PlayerMenu.Subtitles -> "No subtitle tracks in this file."
        PlayerMenu.Quality -> "Quality options appear when playback starts."
        PlayerMenu.Chapters -> "This file has no chapters."
        PlayerMenu.Speed -> "No speed options."
    }

    LaunchedEffect(menu, options.size) {
        delay(110)
        val target = if (options.isEmpty()) closeFocus else focusRequester
        runCatching { target.requestFocus() }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.55f)),
        contentAlignment = Alignment.CenterEnd,
    ) {
        Column(
            modifier = Modifier
                .fillMaxHeight()
                .width(540.dp)
                .background(Color(0xF20C131D))
                .padding(28.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = menuTitle(menu),
                        style = MaterialTheme.typography.headlineMedium,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Text(
                        text = state.title,
                        style = MaterialTheme.typography.bodyMedium,
                        color = StreamLiftMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                TvButton(
                    text = "Close",
                    compact = true,
                    onClick = onDismiss,
                    focusRequester = if (options.isEmpty()) closeFocus else null,
                )
            }

            Spacer(Modifier.height(22.dp))

            if (options.isEmpty()) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = emptyMessage,
                        style = MaterialTheme.typography.bodyLarge,
                        color = StreamLiftMuted,
                    )
                }
            } else {
                TvLazyColumn(
                    modifier = Modifier.weight(1f),
                    contentPadding = PaddingValues(vertical = 4.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    items(
                        count = options.size,
                        key = { index -> options[index].id ?: "option-$index" },
                    ) { index ->
                        MenuRow(
                            option = options[index],
                            onClick = { onSelect(menu, options[index].id) },
                            focusRequester = if (index == initialFocus) focusRequester else null,
                        )
                    }
                }
            }

            Spacer(Modifier.height(14.dp))
            Text(
                text = "Use the D-pad to choose. Press Back to close.",
                style = MaterialTheme.typography.bodyMedium,
                color = StreamLiftMuted.copy(alpha = 0.65f),
            )
        }
    }
}

@Composable
private fun MenuRow(
    option: MenuOption,
    onClick: () -> Unit,
    focusRequester: FocusRequester?,
) {
    var focused by remember { mutableStateOf(false) }
    val interaction = remember { MutableInteractionSource() }
    val shape = RoundedCornerShape(10.dp)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(
                if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier,
            )
            .tvFocusSurface(
                focused = focused,
                selected = option.selected,
                shape = shape,
            )
            .onFocusChanged { focused = it.isFocused }
            .clickable(
                interactionSource = interaction,
                indication = null,
                onClick = onClick,
            )
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .width(3.dp)
                .height(30.dp)
                .clip(RoundedCornerShape(2.dp))
                .background(
                    if (option.selected) StreamLiftFocusOutline else Color.Transparent,
                ),
        )
        Spacer(Modifier.width(13.dp))
        Box(
            modifier = Modifier
                .size(22.dp)
                .clip(CircleShape)
                .then(
                    if (option.selected) {
                        Modifier.background(StreamLiftFocusOutline)
                    } else {
                        Modifier.border(1.dp, Color.White.copy(alpha = 0.14f), CircleShape)
                    },
                ),
            contentAlignment = Alignment.Center,
        ) {
            if (option.selected) {
                Icon(
                    imageVector = Icons.Filled.Check,
                    contentDescription = null,
                    tint = Color(0xFF04101F),
                    modifier = Modifier.size(15.dp),
                )
            }
        }
        Spacer(Modifier.width(13.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = option.label,
                style = MaterialTheme.typography.titleMedium,
                color = Color.White,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (!option.detail.isNullOrBlank()) {
                Text(
                    text = option.detail,
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (focused) StreamLiftFocusSecondaryText else StreamLiftMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

private fun menuTitle(menu: PlayerMenu): String {
    return when (menu) {
        PlayerMenu.Audio -> "Audio track"
        PlayerMenu.Subtitles -> "Subtitles"
        PlayerMenu.Quality -> "Quality"
        PlayerMenu.Chapters -> "Chapters"
        PlayerMenu.Speed -> "Playback speed"
    }
}

private fun qualityLabel(state: PlayerUiState): String {
    val selected = state.qualityTracks.firstOrNull { it.id == state.selectedQualityId }
    return selected?.label
        ?: state.targetHeight?.let { "${it}p" }
        ?: state.sourceHeight?.let { "${it}p" }
        ?: "Auto"
}

private fun speedLabel(speed: Float): String {
    val whole = speed.toInt()
    return if (abs(speed - whole.toFloat()) < 0.01f) {
        "${whole}×"
    } else {
        "${speed}×"
    }
}
