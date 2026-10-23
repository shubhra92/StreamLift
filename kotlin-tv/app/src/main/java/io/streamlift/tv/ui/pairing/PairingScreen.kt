package io.streamlift.tv.ui.pairing

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.streamlift.tv.AppState
import io.streamlift.tv.ui.components.ScreenBackground
import io.streamlift.tv.ui.components.StreamLiftLogo
import io.streamlift.tv.ui.components.TvButton
import io.streamlift.tv.ui.theme.StreamLiftAccent
import io.streamlift.tv.ui.theme.StreamLiftMuted
import io.streamlift.tv.ui.theme.StreamLiftSurface
import io.streamlift.tv.util.formatRemaining
import kotlinx.coroutines.delay

@Composable
fun PairingScreen(
    state: AppState,
    onRetry: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val retryFocus = remember { FocusRequester() }
    val changeServerFocus = remember { FocusRequester() }
    val hasCode = !state.pairingCode.isNullOrBlank()

    LaunchedEffect(hasCode, state.pairingError, state.pairingStarting) {
        delay(200)
        if (hasCode) {
            runCatching { changeServerFocus.requestFocus() }
        } else {
            runCatching { retryFocus.requestFocus() }
        }
    }

    ScreenBackground {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(
                    Brush.radialGradient(
                        colors = listOf(
                            StreamLiftAccent.copy(alpha = 0.14f),
                            Color.Transparent,
                        ),
                    ),
                ),
        )

        Column(
            modifier = Modifier
                .align(Alignment.Center)
                .widthIn(max = 1040.dp)
                .padding(horizontal = 56.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            StreamLiftLogo()
            Spacer(Modifier.height(44.dp))

            Text(
                text = when {
                    hasCode -> "Enter this code on your phone"
                    state.pairingStarting -> "Connecting to StreamLift…"
                    state.pairingError != null -> "Pairing paused"
                    else -> "Waiting for StreamLift…"
                },
                style = MaterialTheme.typography.headlineLarge,
                color = MaterialTheme.colorScheme.onBackground,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(10.dp))
            Text(
                text = "Open ${state.serverUrl.ifBlank { "your StreamLift server" }} in your browser, go to Watch, and choose Connect to TV.",
                style = MaterialTheme.typography.bodyLarge,
                color = StreamLiftMuted,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(34.dp))

            when {
                hasCode -> {
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(24.dp))
                            .background(StreamLiftSurface)
                            .padding(horizontal = 64.dp, vertical = 30.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = formatPairingCode(state.pairingCode.orEmpty()),
                            fontFamily = FontFamily.Monospace,
                            fontWeight = FontWeight.Bold,
                            fontSize = 88.sp,
                            letterSpacing = 8.sp,
                            color = StreamLiftAccent,
                        )
                    }
                    Spacer(Modifier.height(20.dp))
                    Text(
                        text = "Code expires in ${formatRemaining(state.pairingExpiresInMs)}",
                        style = MaterialTheme.typography.titleMedium,
                        color = if (state.pairingExpiresInMs < 60_000) {
                            MaterialTheme.colorScheme.error
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                    )
                    Spacer(Modifier.height(18.dp))
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        CircularProgressIndicator(
                            color = StreamLiftAccent,
                            strokeWidth = 2.dp,
                            modifier = Modifier.size(18.dp),
                        )
                        Text(
                            text = state.pairingError
                                ?: "Waiting for approval… Keep this screen open.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = if (state.pairingError != null) {
                                MaterialTheme.colorScheme.error
                            } else {
                                StreamLiftMuted
                            },
                        )
                    }
                }

                state.pairingStarting -> {
                    CircularProgressIndicator(
                        color = StreamLiftAccent,
                        strokeWidth = 3.dp,
                        modifier = Modifier.size(42.dp),
                    )
                    Spacer(Modifier.height(18.dp))
                    Text(
                        text = "Creating a secure connection code…",
                        style = MaterialTheme.typography.bodyLarge,
                        color = StreamLiftMuted,
                    )
                }

                else -> {
                    if (state.pairingError != null) {
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(14.dp))
                                .background(MaterialTheme.colorScheme.error.copy(alpha = 0.12f))
                                .padding(horizontal = 22.dp, vertical = 16.dp),
                        ) {
                            Text(
                                text = state.pairingError,
                                color = MaterialTheme.colorScheme.error,
                                style = MaterialTheme.typography.bodyLarge,
                                textAlign = TextAlign.Center,
                            )
                        }
                        Spacer(Modifier.height(22.dp))
                    }
                    TvButton(
                        text = "Show a new code",
                        icon = Icons.Filled.Refresh,
                        primary = true,
                        onClick = onRetry,
                        focusRequester = retryFocus,
                    )
                }
            }

            Spacer(Modifier.height(40.dp))
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Text(
                    text = "Server: ${state.serverUrl}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = StreamLiftMuted.copy(alpha = 0.8f),
                )
                TvButton(
                    text = "Change server",
                    icon = Icons.Filled.Settings,
                    compact = true,
                    onClick = onOpenSettings,
                    focusRequester = changeServerFocus,
                )
            }
        }
    }
}

private fun formatPairingCode(code: String): String {
    val normalized = code.uppercase().filter { it.isLetterOrDigit() }
    if (normalized.length <= 3) return normalized
    return "${normalized.take(3)}-${normalized.drop(3)}"
}
