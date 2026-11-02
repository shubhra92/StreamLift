package io.streamlift.tv.ui.library

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.tv.foundation.lazy.list.TvLazyColumn
import io.streamlift.tv.data.RenderQuality
import io.streamlift.tv.ui.components.TvButton
import io.streamlift.tv.ui.components.tvFocusSurface
import io.streamlift.tv.ui.theme.StreamLiftAccent
import io.streamlift.tv.ui.theme.StreamLiftFocusOutline
import io.streamlift.tv.ui.theme.StreamLiftMuted
import io.streamlift.tv.ui.theme.StreamLiftOutline
import io.streamlift.tv.ui.theme.StreamLiftSurface
import io.streamlift.tv.ui.theme.StreamLiftSurfaceVariant
import io.streamlift.tv.util.cleanMediaTitle
import io.streamlift.tv.util.formatBytes
import kotlinx.coroutines.delay
import java.util.Locale

/**
 * TV-side pre-render manager.
 *
 * Opened by long-pressing a library card. The user picks one or more qualities,
 * the worker renders them in the background, and completed qualities play from
 * static HLS with no encoder work.
 */
@Composable
fun RenderSheet(
    state: RenderSheetState,
    onToggleQuality: (String) -> Unit,
    onStart: () -> Unit,
    onCancelQuality: (String) -> Unit,
    onDeleteQuality: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val closeFocus = remember { FocusRequester() }
    var pendingDelete by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        delay(160)
        runCatching { closeFocus.requestFocus() }
    }
    LaunchedEffect(state.qualities) {
        // Never leave a delete armed after the list changes underneath it.
        if (state.qualities.none { it.id == pendingDelete }) {
            pendingDelete = null
        }
    }

    Dialog(
        onDismissRequest = onDismiss,
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
                .background(Color(0xC905080D)),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth(0.82f)
                    .widthIn(max = 860.dp)
                    .heightIn(max = 760.dp)
                    .clip(RoundedCornerShape(20.dp))
                    .background(StreamLiftSurface)
                    .border(1.dp, StreamLiftOutline, RoundedCornerShape(20.dp))
                    .padding(horizontal = 30.dp, vertical = 26.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        imageVector = Icons.Filled.Movie,
                        contentDescription = null,
                        tint = StreamLiftAccent,
                        modifier = Modifier.size(30.dp),
                    )
                    Spacer(Modifier.width(14.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = "Pre-render for smooth playback",
                            style = MaterialTheme.typography.headlineSmall,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                        Text(
                            text = "${cleanMediaTitle(state.file.displayName)} • ${state.worker.name}",
                            style = MaterialTheme.typography.bodyMedium,
                            color = StreamLiftMuted,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }

                Spacer(Modifier.height(18.dp))

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(18.dp),
                ) {
                    Text(
                        text = if (state.renderedCount > 0) {
                            "${state.renderedCount} quality ready • ${formatBytes(state.renderedBytes)} on disk"
                        } else {
                            "Nothing rendered yet"
                        },
                        style = MaterialTheme.typography.bodyMedium,
                        color = StreamLiftMuted,
                    )
                    Spacer(Modifier.weight(1f))
                    state.freeBytes?.let { free ->
                        Text(
                            text = "Worker free space: ${formatBytes(free)}",
                            style = MaterialTheme.typography.bodyMedium,
                            color = StreamLiftMuted,
                        )
                    }
                }

                if (state.error != null) {
                    Spacer(Modifier.height(12.dp))
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .background(Color(0x33EF4444))
                            .padding(horizontal = 14.dp, vertical = 10.dp),
                    ) {
                        Text(
                            text = state.error,
                            style = MaterialTheme.typography.bodyMedium,
                            color = Color(0xFFFF9A9A),
                        )
                    }
                }

                Spacer(Modifier.height(16.dp))

                when {
                    state.loading && state.qualities.isEmpty() -> {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .weight(1f),
                            contentAlignment = Alignment.Center,
                        ) {
                            CircularProgressIndicator(color = StreamLiftAccent)
                        }
                    }

                    state.qualities.isEmpty() -> {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .weight(1f),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                text = "This file cannot be pre-rendered.",
                                style = MaterialTheme.typography.bodyLarge,
                                color = StreamLiftMuted,
                            )
                        }
                    }

                    else -> {
                        TvLazyColumn(
                            modifier = Modifier
                                .fillMaxWidth()
                                .weight(1f),
                            contentPadding = PaddingValues(vertical = 4.dp),
                            verticalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            items(
                                count = state.qualities.size,
                                key = { index -> state.qualities[index].id },
                            ) { index ->
                                val quality = state.qualities[index]
                                RenderQualityRow(
                                    quality = quality,
                                    selected = quality.id in state.selected,
                                    busy = state.busy,
                                    deleteArmed = pendingDelete == quality.id,
                                    onToggle = { onToggleQuality(quality.id) },
                                    onCancel = { onCancelQuality(quality.id) },
                                    onDelete = {
                                        if (pendingDelete == quality.id) {
                                            pendingDelete = null
                                            onDeleteQuality(quality.id)
                                        } else {
                                            pendingDelete = quality.id
                                        }
                                    },
                                )
                            }
                        }
                    }
                }

                Spacer(Modifier.height(16.dp))

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = "Renders stay on the worker until you delete them or the worker session ends.",
                        style = MaterialTheme.typography.bodySmall,
                        color = StreamLiftMuted.copy(alpha = 0.8f),
                        modifier = Modifier.weight(1f),
                    )
                    Spacer(Modifier.width(18.dp))
                    TvButton(
                        text = "Close",
                        compact = true,
                        onClick = onDismiss,
                        focusRequester = closeFocus,
                    )
                    Spacer(Modifier.width(12.dp))
                    TvButton(
                        text = when {
                            state.busy -> "Working…"
                            state.selected.isEmpty() -> "Render selected"
                            state.selected.size == 1 -> "Render 1 quality"
                            else -> "Render ${state.selected.size} qualities"
                        },
                        icon = Icons.Filled.Movie,
                        primary = true,
                        compact = true,
                        enabled = state.selected.isNotEmpty() && !state.busy,
                        onClick = onStart,
                    )
                }
            }
        }
    }
}

@Composable
private fun RenderQualityRow(
    quality: RenderQuality,
    selected: Boolean,
    busy: Boolean,
    deleteArmed: Boolean,
    onToggle: () -> Unit,
    onCancel: () -> Unit,
    onDelete: () -> Unit,
) {
    var focused by remember { mutableStateOf(false) }
    val job = quality.job
    val rendering = job?.state == "rendering" || job?.state == "queued"
    val failed = job?.state == "failed"
    val resettable = failed || job?.state == "canceled"
    val selectable = !quality.rendered && !rendering && !busy
    val shape = RoundedCornerShape(12.dp)
    val interaction = remember { MutableInteractionSource() }
    val progress = (job?.progress ?: 0.0).coerceIn(0.0, 1.0).toFloat()

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .tvFocusSurface(
                focused = focused,
                shape = shape,
                selected = selected,
                unfocusedColor = StreamLiftSurfaceVariant.copy(alpha = 0.55f),
            )
            .onFocusChanged { focused = it.isFocused }
            .clickable(
                enabled = selectable,
                interactionSource = interaction,
                indication = null,
                onClick = onToggle,
            )
            .padding(horizontal = 16.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SelectionBox(selected = selected, enabled = selectable)
        Spacer(Modifier.width(14.dp))

        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = quality.label,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                if (quality.copy) {
                    Spacer(Modifier.width(8.dp))
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(4.dp))
                            .background(Color(0x3322C55E))
                            .padding(horizontal = 7.dp, vertical = 2.dp),
                    ) {
                        Text(
                            text = "FAST REMUX",
                            style = MaterialTheme.typography.labelSmall,
                            color = Color(0xFF7BE6A4),
                            fontWeight = FontWeight.Bold,
                        )
                    }
                }
                Spacer(Modifier.width(10.dp))
                Text(
                    text = when {
                        quality.rendered -> formatBytes(job?.bytes ?: 0L)
                        quality.estimatedBytes != null -> "~${formatBytes(quality.estimatedBytes)}"
                        else -> ""
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = StreamLiftMuted,
                )
            }

            Spacer(Modifier.height(4.dp))
            Text(
                text = statusText(quality),
                style = MaterialTheme.typography.bodyMedium,
                color = when {
                    quality.rendered -> Color(0xFF7BE6A4)
                    failed -> Color(0xFFFF9A9A)
                    else -> StreamLiftMuted
                },
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )

            if (rendering) {
                Spacer(Modifier.height(8.dp))
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(6.dp)
                        .clip(RoundedCornerShape(3.dp))
                        .background(StreamLiftOutline),
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth(progress.coerceAtLeast(0.02f))
                            .fillMaxHeight()
                            .clip(RoundedCornerShape(3.dp))
                            .background(StreamLiftAccent),
                    )
                }
            } else if (failed) {
                Spacer(Modifier.height(3.dp))
                Text(
                    text = "Select this quality to retry",
                    style = MaterialTheme.typography.bodySmall,
                    color = StreamLiftMuted,
                )
            } else if (resettable) {
                Spacer(Modifier.height(3.dp))
                Text(
                    text = "Select this quality to retry",
                    style = MaterialTheme.typography.bodySmall,
                    color = StreamLiftMuted,
                )
            }
        }

        Spacer(Modifier.width(12.dp))
        when {
            rendering -> TvButton(
                text = "Cancel",
                compact = true,
                enabled = !busy,
                onClick = onCancel,
            )

            quality.rendered -> TvButton(
                text = if (deleteArmed) "Confirm delete" else "Delete",
                compact = true,
                enabled = !busy,
                onClick = onDelete,
            )
        }
    }
}

@Composable
private fun SelectionBox(selected: Boolean, enabled: Boolean) {
    val shape = RoundedCornerShape(5.dp)
    Box(
        modifier = Modifier
            .size(22.dp)
            .clip(shape)
            .background(if (selected) StreamLiftAccent else Color.Transparent)
            .border(
                width = 2.dp,
                color = when {
                    selected -> StreamLiftAccent
                    enabled -> StreamLiftFocusOutline
                    else -> StreamLiftOutline
                },
                shape = shape,
            ),
        contentAlignment = Alignment.Center,
    ) {
        if (selected) {
            Icon(
                imageVector = Icons.Filled.Check,
                contentDescription = null,
                tint = Color(0xFF04101F),
                modifier = Modifier.size(15.dp),
            )
        }
    }
}

private fun statusText(quality: RenderQuality): String {
    if (quality.rendered) return "Ready — plays without transcoding"
    val job = quality.job ?: return "Not rendered"
    return when (job.state) {
        "queued" -> "Queued"
        "rendering" -> buildString {
            append("Rendering ")
            append(String.format(Locale.US, "%.0f%%", job.progress * 100))
            job.speed?.let { speed ->
                if (speed > 0) append(String.format(Locale.US, " · %.1fx", speed))
            }
            val eta = formatEta(job.etaSeconds)
            if (eta != null) append(" · ").append(eta)
        }
        "failed" -> job.detail ?: "Pre-render failed"
        "canceled" -> "Canceled"
        "ready" -> "Ready — plays without transcoding"
        else -> "Not rendered"
    }
}

private fun formatEta(seconds: Double?): String? {
    if (seconds == null || !seconds.isFinite() || seconds <= 0.0) return null
    val total = seconds.toLong()
    return when {
        total < 60 -> "${total}s left"
        total < 3600 -> "${total / 60}m ${total % 60}s left"
        else -> "${total / 3600}h ${(total % 3600) / 60}m left"
    }
}
