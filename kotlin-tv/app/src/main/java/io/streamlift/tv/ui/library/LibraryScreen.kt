package io.streamlift.tv.ui.library

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
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
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.VideoLibrary
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.foundation.lazy.list.TvLazyColumn
import androidx.tv.foundation.lazy.list.TvLazyRow
import coil.compose.SubcomposeAsyncImage
import coil.request.ImageRequest
import io.streamlift.tv.data.CatalogFile
import io.streamlift.tv.data.CatalogGroup
import io.streamlift.tv.data.CatalogWorker
import io.streamlift.tv.data.PlayerItem
import io.streamlift.tv.StreamLiftTvApp
import io.streamlift.tv.data.toPlayerItem
import io.streamlift.tv.ui.components.ScreenBackground
import io.streamlift.tv.ui.components.SectionHeader
import io.streamlift.tv.ui.components.StreamLiftLogo
import io.streamlift.tv.ui.components.TvButton
import io.streamlift.tv.ui.components.TvIconButton
import io.streamlift.tv.ui.components.tvFocusSurface
import io.streamlift.tv.ui.theme.StreamLiftBackground
import io.streamlift.tv.ui.theme.StreamLiftFocusOutline
import io.streamlift.tv.ui.theme.StreamLiftMuted
import io.streamlift.tv.ui.theme.StreamLiftSurface
import io.streamlift.tv.ui.theme.StreamLiftSurfaceVariant
import io.streamlift.tv.util.cleanMediaTitle
import io.streamlift.tv.util.extractYear
import io.streamlift.tv.util.formatBytes
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

@Composable
fun LibraryScreen(
    deviceName: String?,
    onPlay: (PlayerItem, List<PlayerItem>) -> Unit,
    onOpenSettings: () -> Unit,
    onAuthExpired: () -> Unit,
) {
    val app = LocalContext.current.applicationContext as StreamLiftTvApp
    val viewModel: LibraryViewModel = viewModel(factory = LibraryViewModel.Factory(app.container))
    val state by viewModel.state.collectAsStateWithLifecycle()

    var selectedWorker by remember { mutableStateOf<CatalogWorker?>(null) }
    var initialFocusDone by remember { mutableStateOf(false) }
    val heroFocus = remember { FocusRequester() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        viewModel.authExpired.collect { onAuthExpired() }
    }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        viewModel.refresh()
        // The player and the settings screen are separate activities, so the
        // library window loses focus while they are open. Put the remote back
        // on the primary action when the user returns.
        if (!state.loading && state.groups.isNotEmpty()) {
            scope.launch {
                delay(220)
                runCatching { heroFocus.requestFocus() }
            }
        }
    }
    LaunchedEffect(Unit) {
        while (isActive) {
            delay(20_000)
            viewModel.refresh()
        }
    }
    // Only grab initial focus once. Background refreshes can change the
    // worker list and must not steal focus from what the viewer is doing.
    LaunchedEffect(state.loading, state.groups.isNotEmpty()) {
        if (!initialFocusDone && !state.loading && state.groups.isNotEmpty()) {
            delay(220)
            if (runCatching { heroFocus.requestFocus() }.isSuccess) {
                initialFocusDone = true
            }
        }
    }

    val latestFiles = remember(state.groups) {
        state.groups
            .flatMap { group -> group.files.map { group.worker to it } }
            .sortedByDescending { (_, file) -> file.addedAt ?: "" }
            .distinctBy { (worker, file) -> heroKey(worker, file) }
            .take(HERO_ITEM_LIMIT)
    }
    val continueFiles = state.continueWatching.map { it.worker to it.file }
    val progressByKey = remember(state.continueWatching) {
        state.continueWatching.associate { item ->
            item.file.key to if (item.durationMs > 0L) {
                item.positionMs.toFloat() / item.durationMs.toFloat()
            } else {
                0f
            }
        }
    }

    fun play(file: CatalogFile, worker: CatalogWorker) {
        val group = state.groups.firstOrNull { it.worker.id == worker.id }
        val sourceFiles = group?.files ?: listOf(file)
        val items = sourceFiles.map { it.toPlayerItem(worker) }
        onPlay(file.toPlayerItem(worker), items)
    }

    ScreenBackground {
        Column(modifier = Modifier.fillMaxSize()) {
            LibraryTopBar(
                deviceName = deviceName,
                refreshing = state.refreshing,
                onRefresh = { viewModel.refresh(force = true) },
                onOpenSettings = onOpenSettings,
            )

            when {
                state.loading -> {
                    Box(
                        modifier = Modifier.fillMaxSize(),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator(
                            color = MaterialTheme.colorScheme.primary,
                            strokeWidth = 3.dp,
                            modifier = Modifier.size(42.dp),
                        )
                    }
                }

                state.groups.isEmpty() -> {
                    EmptyLibrary(
                        state = state,
                        onRetry = { viewModel.refresh(force = true) },
                        onOpenSettings = onOpenSettings,
                    )
                }

                else -> {
                    LibraryFeed(
                        state = state,
                        heroItems = latestFiles,
                        heroFocus = heroFocus,
                        continueFiles = continueFiles,
                        progressByKey = progressByKey,
                        onPlay = { file, worker -> play(file, worker) },
                        onSeeAll = { worker -> selectedWorker = worker },
                    )
                }
            }
        }

        val group = selectedWorker?.let { worker ->
            state.groups.firstOrNull { it.worker.id == worker.id }
        }
        if (group != null) {
            WorkerGridOverlay(
                group = group,
                progressByKey = progressByKey,
                onPlay = { file, worker ->
                    selectedWorker = null
                    play(file, worker)
                },
                onClose = {
                    selectedWorker = null
                    // The grid lives in its own dialog window. Returning from
                    // it must restore focus to the library explicitly.
                    scope.launch {
                        delay(180)
                        runCatching { heroFocus.requestFocus() }
                    }
                },
            )
        }
    }
}

@Composable
private fun LibraryTopBar(
    deviceName: String?,
    refreshing: Boolean,
    onRefresh: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(84.dp)
            .padding(horizontal = 48.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StreamLiftLogo(compact = true)
        Spacer(Modifier.weight(1f))

        if (!deviceName.isNullOrBlank()) {
            Box(
                modifier = Modifier
                    .size(7.dp)
                    .clip(CircleShape)
                    .background(Color(0xFF42D392)),
            )
            Spacer(Modifier.width(8.dp))
            Text(
                text = deviceName,
                style = MaterialTheme.typography.bodyMedium,
                color = StreamLiftMuted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 280.dp),
            )
            Spacer(Modifier.width(20.dp))
        }

        // Keep the refresh button composed while it spins. Replacing it with a
        // progress indicator would drop focus if the viewer was on that icon.
        TvIconButton(
            icon = Icons.Filled.Refresh,
            contentDescription = if (refreshing) "Refreshing library" else "Refresh library",
            onClick = { if (!refreshing) onRefresh() },
            loading = refreshing,
        )

        Spacer(Modifier.width(6.dp))
        TvIconButton(
            icon = Icons.Filled.Settings,
            contentDescription = "Settings",
            onClick = onOpenSettings,
        )
    }
}

@Composable
private fun LibraryFeed(
    state: LibraryUiState,
    heroItems: List<Pair<CatalogWorker, CatalogFile>>,
    heroFocus: FocusRequester,
    continueFiles: List<Pair<CatalogWorker, CatalogFile>>,
    progressByKey: Map<String, Float>,
    onPlay: (CatalogFile, CatalogWorker) -> Unit,
    onSeeAll: (CatalogWorker) -> Unit,
) {
    TvLazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 64.dp),
        verticalArrangement = Arrangement.spacedBy(26.dp),
    ) {
        if (state.error != null) {
            item {
                ErrorBanner(
                    message = state.error,
                    modifier = Modifier.padding(horizontal = 48.dp),
                )
            }
        }

        if (heroItems.isNotEmpty()) {
            item {
                HeroCarousel(
                    items = heroItems,
                    progressByKey = progressByKey,
                    focusRequester = heroFocus,
                    onPlay = onPlay,
                    onSeeAll = onSeeAll,
                )
            }
        }

        if (state.unreachableWorkers.isNotEmpty()) {
            item {
                UnreachableBanner(
                    names = state.unreachableWorkers.joinToString { it.name },
                    modifier = Modifier.padding(horizontal = 48.dp),
                )
            }
        }

        if (continueFiles.isNotEmpty()) {
            item {
                MediaRow(
                    title = "Continue Watching",
                    subtitle = "Pick up where you left off",
                    items = continueFiles,
                    progressByKey = progressByKey,
                    onPlay = onPlay,
                )
            }
        }

        items(
            count = state.groups.size,
            key = { index -> state.groups[index].worker.id },
        ) { index ->
            val group = state.groups[index]
            val items = group.files.map { group.worker to it }
            MediaRow(
                title = group.worker.name,
                subtitle = "${group.files.size} ${if (group.files.size == 1) "item" else "items"}",
                items = items,
                progressByKey = progressByKey,
                onPlay = onPlay,
                seeAll = if (group.files.size > ROW_LIMIT) {
                    { onSeeAll(group.worker) }
                } else {
                    null
                },
            )
        }

        item {
            Text(
                text = "Files stream directly from your workers. StreamLift TV cannot add downloads or manage workers.",
                style = MaterialTheme.typography.bodyMedium,
                color = StreamLiftMuted.copy(alpha = 0.65f),
                modifier = Modifier.padding(horizontal = 48.dp, vertical = 12.dp),
            )
        }
    }
}

@Composable
private fun MediaRow(
    title: String,
    subtitle: String? = null,
    items: List<Pair<CatalogWorker, CatalogFile>>,
    progressByKey: Map<String, Float>,
    onPlay: (CatalogFile, CatalogWorker) -> Unit,
    seeAll: (() -> Unit)? = null,
) {
    Column(modifier = Modifier.fillMaxWidth()) {
        SectionHeader(
            title = title,
            subtitle = subtitle,
            modifier = Modifier.padding(horizontal = 48.dp),
            trailing = seeAll?.let {
                {
                    TvButton(
                        text = "See all",
                        compact = true,
                        onClick = it,
                    )
                }
            },
        )
        Spacer(Modifier.height(12.dp))
        TvLazyRow(
            contentPadding = PaddingValues(horizontal = 48.dp),
            horizontalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            items(
                count = minOf(items.size, ROW_LIMIT),
                key = { index -> items[index].second.key },
            ) { index ->
                val (worker, file) = items[index]
                MediaCard(
                    file = file,
                    worker = worker,
                    progress = progressByKey[file.key],
                    onClick = { onPlay(file, worker) },
                    modifier = Modifier.padding(vertical = 4.dp),
                )
            }
        }
    }
}

private data class HeroSlide(
    val index: Int,
    val worker: CatalogWorker,
    val file: CatalogFile,
)

@Composable
private fun HeroCarousel(
    items: List<Pair<CatalogWorker, CatalogFile>>,
    progressByKey: Map<String, Float>,
    focusRequester: FocusRequester,
    onPlay: (CatalogFile, CatalogWorker) -> Unit,
    onSeeAll: (CatalogWorker) -> Unit,
) {
    if (items.isEmpty()) return

    val slides = remember(items) {
        items.mapIndexed { index, (worker, file) -> HeroSlide(index, worker, file) }
    }
    var selectedKey by remember {
        mutableStateOf(heroKey(items.first().first, items.first().second))
    }
    LaunchedEffect(slides) {
        if (slides.none { heroKey(it.worker, it.file) == selectedKey }) {
            selectedKey = heroKey(slides.first().worker, slides.first().file)
        }
    }

    val selectedIndex = slides
        .indexOfFirst { heroKey(it.worker, it.file) == selectedKey }
        .takeIf { it >= 0 } ?: 0
    val current = slides[selectedIndex]
    val activeKey = heroKey(current.worker, current.file)
    val progress = progressByKey[current.file.key]

    var interactionTick by remember { mutableIntStateOf(0) }
    var cardFocused by remember { mutableStateOf(false) }
    var screenResumed by remember { mutableStateOf(true) }
    val carouselFocus = remember { FocusRequester() }
    val cardShape = remember { RoundedCornerShape(22.dp) }

    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { screenResumed = true }
    LifecycleEventEffect(Lifecycle.Event.ON_PAUSE) { screenResumed = false }

    LaunchedEffect(activeKey, interactionTick, cardFocused, screenResumed, slides.size) {
        if (slides.size <= 1 || cardFocused || !screenResumed) return@LaunchedEffect
        delay(HERO_AUTO_ADVANCE_MS)
        val from = slides.indexOfFirst { heroKey(it.worker, it.file) == activeKey }
            .takeIf { it >= 0 } ?: 0
        val next = slides[(from + 1) % slides.size]
        selectedKey = heroKey(next.worker, next.file)
    }

    fun select(index: Int) {
        val slide = slides.getOrNull(index) ?: return
        selectedKey = heroKey(slide.worker, slide.file)
        interactionTick++
    }

    fun step(delta: Int) {
        if (slides.size <= 1) return
        val from = slides.indexOfFirst { heroKey(it.worker, it.file) == activeKey }
            .takeIf { it >= 0 } ?: 0
        select((from + delta).mod(slides.size))
    }

    Box(
        modifier = Modifier
            .padding(horizontal = 48.dp)
            .fillMaxWidth()
            .height(390.dp)
            .clip(cardShape)
            .background(StreamLiftSurfaceVariant)
            .focusRequester(carouselFocus)
            .onFocusChanged { cardFocused = it.isFocused }
            .focusable()
            .onPreviewKeyEvent { event ->
                if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                if (cardFocused) {
                    when (event.key) {
                        Key.DirectionLeft -> {
                            step(-1)
                            return@onPreviewKeyEvent true
                        }
                        Key.DirectionRight -> {
                            step(1)
                            return@onPreviewKeyEvent true
                        }
                        Key.DirectionDown -> {
                            focusRequester.requestFocus()
                            return@onPreviewKeyEvent true
                        }
                    }
                } else if (event.key == Key.DirectionUp) {
                    carouselFocus.requestFocus()
                    return@onPreviewKeyEvent true
                }
                interactionTick++
                false
            },
    ) {
        AnimatedContent(
            targetState = current,
            modifier = Modifier.fillMaxSize(),
            transitionSpec = {
                val direction = if (targetState.index > initialState.index) 1 else -1
                (
                    slideInHorizontally(animationSpec = tween(450)) { width ->
                        direction * width / 10
                    } + fadeIn(tween(450))
                ) togetherWith (
                    slideOutHorizontally(animationSpec = tween(450)) { width ->
                        -direction * width / 10
                    } + fadeOut(tween(300))
                )
            },
            label = "heroBackdrop",
        ) { slide ->
            HeroBackdrop(slide.file)
        }

        Column(
            modifier = Modifier
                .align(Alignment.BottomStart)
                .fillMaxWidth()
                .padding(40.dp),
        ) {
            AnimatedContent(
                targetState = current,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(190.dp),
                contentAlignment = Alignment.BottomStart,
                transitionSpec = {
                    fadeIn(tween(350)) togetherWith fadeOut(tween(250))
                },
                label = "heroCopy",
            ) { slide ->
                HeroCopy(
                    file = slide.file,
                    worker = slide.worker,
                    progress = progressByKey[slide.file.key],
                )
            }

            Spacer(Modifier.height(18.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                TvButton(
                    text = if (progress != null && progress > 0f) "Resume" else "Play",
                    icon = Icons.Filled.PlayArrow,
                    primary = true,
                    onClick = { onPlay(current.file, current.worker) },
                    focusRequester = focusRequester,
                    modifier = Modifier.width(152.dp),
                )
                TvButton(
                    text = "More from ${current.worker.name}",
                    compact = true,
                    onClick = { onSeeAll(current.worker) },
                )
                Spacer(Modifier.weight(1f))
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    slides.forEach { slide ->
                        HeroDot(
                            selected = heroKey(slide.worker, slide.file) == activeKey,
                        )
                    }
                }
            }

            if (progress != null && progress > 0f) {
                Spacer(Modifier.height(16.dp))
                Box(
                    modifier = Modifier
                        .width(320.dp)
                        .height(4.dp)
                        .clip(CircleShape)
                        .background(Color.White.copy(alpha = 0.22f)),
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth(progress.coerceIn(0f, 1f))
                            .height(4.dp)
                            .background(MaterialTheme.colorScheme.primary),
                    )
                }
            }
        }

        Box(
            modifier = Modifier
                .matchParentSize()
                .tvFocusSurface(
                    focused = cardFocused,
                    shape = cardShape,
                    focusedColor = Color.Transparent,
                    unfocusedColor = Color.Transparent,
                ),
        )
    }
}

@Composable
private fun HeroBackdrop(file: CatalogFile) {
    Box(modifier = Modifier.fillMaxSize()) {
        if (!file.isAudio && !file.thumbnailUrl.isNullOrBlank()) {
            SubcomposeAsyncImage(
                model = ImageRequest.Builder(LocalContext.current)
                    .data(file.thumbnailUrl)
                    .crossfade(300)
                    .build(),
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
                loading = { HeroPlaceholder(file) },
                error = { HeroPlaceholder(file) },
            )
        } else {
            HeroPlaceholder(file)
        }

        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(
                    Brush.horizontalGradient(
                        colors = listOf(
                            Color(0xF205080D),
                            Color(0xC405080D),
                            Color.Transparent,
                        ),
                    ),
                ),
        )
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(
                    Brush.verticalGradient(
                        colors = listOf(
                            Color.Transparent,
                            Color(0xCC05080D),
                        ),
                    ),
                ),
        )
    }
}

@Composable
private fun HeroCopy(
    file: CatalogFile,
    worker: CatalogWorker,
    progress: Float?,
) {
    val title = remember(file.displayName) { cleanMediaTitle(file.displayName) }
    val metadata = remember(file, worker) { buildMetadata(file, worker) }

    Column(
        modifier = Modifier
            .widthIn(max = 1100.dp)
            .fillMaxHeight(),
        verticalArrangement = Arrangement.Bottom,
    ) {
        Text(
            text = if (progress != null && progress > 0f) "CONTINUE WATCHING" else "LATEST",
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.primary,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = title,
            style = MaterialTheme.typography.displayMedium,
            color = Color.White,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        Spacer(Modifier.height(10.dp))
        Text(
            text = metadata,
            style = MaterialTheme.typography.bodyLarge,
            color = StreamLiftMuted,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun HeroDot(selected: Boolean) {
    Box(
        modifier = Modifier
            .width(20.dp)
            .height(8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .width(if (selected) 18.dp else 8.dp)
                .height(8.dp)
                .clip(CircleShape)
                .background(
                    if (selected) {
                        StreamLiftFocusOutline
                    } else {
                        Color.White.copy(alpha = 0.35f)
                    },
                ),
        )
    }
}

@Composable
private fun HeroPlaceholder(file: CatalogFile) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(
                Brush.linearGradient(
                    colors = listOf(Color(0xFF17243A), Color(0xFF0A1019), Color(0xFF1B1530)),
                ),
            ),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = if (file.isAudio) {
                androidx.compose.material.icons.Icons.Filled.MusicNote
            } else {
                androidx.compose.material.icons.Icons.Filled.Movie
            },
            contentDescription = null,
            tint = Color.White.copy(alpha = 0.12f),
            modifier = Modifier.size(110.dp),
        )
    }
}

@Composable
private fun UnreachableBanner(names: String, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(StreamLiftSurface.copy(alpha = 0.8f))
            .padding(horizontal = 18.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Icons.Filled.CloudOff,
            contentDescription = null,
            tint = StreamLiftMuted,
            modifier = Modifier.size(20.dp),
        )
        Spacer(Modifier.width(10.dp))
        Text(
            text = "Some workers could not be reached: $names. Their files will appear when they are online.",
            style = MaterialTheme.typography.bodyMedium,
            color = StreamLiftMuted,
        )
    }
}

@Composable
private fun ErrorBanner(message: String, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.error.copy(alpha = 0.12f))
            .padding(horizontal = 18.dp, vertical = 12.dp),
    ) {
        Text(
            text = message,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.error,
        )
    }
}

@Composable
private fun EmptyLibrary(
    state: LibraryUiState,
    onRetry: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val retryFocus = remember { FocusRequester() }

    LaunchedEffect(Unit) {
        delay(220)
        runCatching { retryFocus.requestFocus() }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(48.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.widthIn(max = 720.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(84.dp)
                    .clip(RoundedCornerShape(24.dp))
                    .background(StreamLiftSurface),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = if (state.error != null) Icons.Filled.CloudOff else Icons.Filled.VideoLibrary,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(40.dp),
                )
            }
            Spacer(Modifier.height(26.dp))
            Text(
                text = if (state.error != null) "Couldn't load your library" else "Your watch library is empty",
                style = MaterialTheme.typography.headlineLarge,
                color = MaterialTheme.colorScheme.onBackground,
            )
            Spacer(Modifier.height(12.dp))
            Text(
                text = state.error
                    ?: if (state.unreachableWorkers.isNotEmpty()) {
                        "Workers are online but unreachable right now. ${state.unreachableWorkers.joinToString { it.name }} will appear when the connection recovers."
                    } else {
                        "Download a video or audio file to one of your local workers. Every playable file will show up here automatically."
                    },
                style = MaterialTheme.typography.bodyLarge,
                color = StreamLiftMuted,
            )
            Spacer(Modifier.height(28.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                TvButton(
                    text = "Refresh",
                    icon = Icons.Filled.Refresh,
                    primary = true,
                    onClick = onRetry,
                    focusRequester = retryFocus,
                )
                TvButton(
                    text = "Settings",
                    icon = Icons.Filled.Settings,
                    onClick = onOpenSettings,
                )
            }
        }
    }
}

@Composable
private fun WorkerGridOverlay(
    group: CatalogGroup,
    progressByKey: Map<String, Float>,
    onPlay: (CatalogFile, CatalogWorker) -> Unit,
    onClose: () -> Unit,
) {
    val firstFocus = remember { FocusRequester() }
    val rows = remember(group.files) { group.files.chunked(GRID_COLUMNS) }

    LaunchedEffect(group.worker.id) {
        delay(180)
        runCatching { firstFocus.requestFocus() }
    }

    // A Dialog gives the grid its own window, which keeps D-pad focus inside
    // the overlay instead of letting it wander into the library behind.
    Dialog(
        onDismissRequest = onClose,
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            dismissOnBackPress = true,
            dismissOnClickOutside = false,
            decorFitsSystemWindows = false,
        ),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color(0xF2070A0F)),
        ) {
            Column(modifier = Modifier.fillMaxSize()) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 48.dp, vertical = 32.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    TvButton(
                        text = "Back",
                        icon = Icons.AutoMirrored.Filled.ArrowBack,
                        compact = true,
                        onClick = onClose,
                    )
                    Spacer(Modifier.width(20.dp))
                    Column {
                        Text(
                            text = group.worker.name,
                            style = MaterialTheme.typography.headlineMedium,
                            color = MaterialTheme.colorScheme.onBackground,
                        )
                        Text(
                            text = "${group.files.size} ${if (group.files.size == 1) "item" else "items"}",
                            style = MaterialTheme.typography.bodyMedium,
                            color = StreamLiftMuted,
                        )
                    }
                }

                TvLazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(horizontal = 48.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(24.dp),
                ) {
                    items(count = rows.size) { rowIndex ->
                        Row(horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                            rows[rowIndex].forEachIndexed { columnIndex, file ->
                                MediaCard(
                                    file = file,
                                    worker = group.worker,
                                    progress = progressByKey[file.key],
                                    onClick = { onPlay(file, group.worker) },
                                    focusRequester = if (rowIndex == 0 && columnIndex == 0) {
                                        firstFocus
                                    } else {
                                        null
                                    },
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

private fun heroKey(worker: CatalogWorker, file: CatalogFile): String {
    val fileKey = file.key.ifBlank { "${file.downloadId}:${file.fileIndex}" }
    return "${worker.id}:$fileKey"
}

private fun buildMetadata(file: CatalogFile, worker: CatalogWorker): String {
    val parts = mutableListOf<String>()
    parts += worker.name
    parts += if (file.isAudio) "Audio" else "Video"
    extractYear(file.name)?.let { parts += it.toString() }
    formatBytes(file.size).takeIf { it.isNotBlank() }?.let { parts += it }
    return parts.joinToString("  •  ")
}

private const val HERO_ITEM_LIMIT = 5
private const val HERO_AUTO_ADVANCE_MS = 8_000L
private const val ROW_LIMIT = 12
private const val GRID_COLUMNS = 6
