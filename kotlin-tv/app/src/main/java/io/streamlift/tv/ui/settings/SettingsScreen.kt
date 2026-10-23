package io.streamlift.tv.ui.settings

import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.DeleteSweep
import androidx.compose.material.icons.filled.LinkOff
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.foundation.lazy.list.TvLazyColumn
import io.streamlift.tv.BuildConfig
import io.streamlift.tv.data.SettingsStore
import io.streamlift.tv.ui.components.ScreenBackground
import io.streamlift.tv.ui.components.StreamLiftLogo
import io.streamlift.tv.ui.components.TvButton
import io.streamlift.tv.ui.components.TvTextField
import io.streamlift.tv.ui.theme.StreamLiftMuted
import io.streamlift.tv.ui.theme.StreamLiftSurface
import io.streamlift.tv.ui.theme.StreamLiftSurfaceVariant
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(
    serverUrl: String,
    deviceName: String?,
    onSaveServer: (String) -> Unit,
    onDisconnect: () -> Unit,
    onClearResume: () -> Unit,
    onBack: () -> Unit,
) {
    var serverInput by rememberSaveable(serverUrl) { mutableStateOf(serverUrl) }
    var confirmDisconnect by remember { mutableStateOf(false) }
    var resumeCleared by remember { mutableStateOf(false) }
    val backFocus = remember { FocusRequester() }
    val disconnectFocus = remember { FocusRequester() }
    val confirmFocus = remember { FocusRequester() }
    val scope = rememberCoroutineScope()

    BackHandler {
        if (confirmDisconnect) confirmDisconnect = false else onBack()
    }

    LaunchedEffect(Unit) {
        delay(200)
        runCatching { backFocus.requestFocus() }
    }

    ScreenBackground {
        TvLazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 56.dp, vertical = 40.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            item {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    TvButton(
                        text = "Back",
                        icon = Icons.AutoMirrored.Filled.ArrowBack,
                        compact = true,
                        onClick = onBack,
                        focusRequester = backFocus,
                    )
                    Spacer(Modifier.width(20.dp))
                    Text(
                        text = "Settings",
                        style = MaterialTheme.typography.headlineLarge,
                        color = MaterialTheme.colorScheme.onBackground,
                    )
                    Spacer(Modifier.weight(1f))
                    StreamLiftLogo(compact = true)
                }
            }

            item {
                SettingsCard(title = "StreamLift server") {
                    Text(
                        text = "The TV talks directly to this Next.js server for pairing and your library.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = StreamLiftMuted,
                    )
                    Spacer(Modifier.height(14.dp))
                    TvTextField(
                        value = serverInput,
                        onValueChange = { serverInput = it },
                        label = "Server URL",
                        placeholder = "https://streamlift.example.com",
                    )
                    Spacer(Modifier.height(14.dp))
                    val normalized = SettingsStore.normalize(serverInput)
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        TvButton(
                            text = "Save & reconnect",
                            primary = true,
                            enabled = normalized.isNotBlank() && normalized != serverUrl,
                            onClick = { onSaveServer(serverInput) },
                        )
                        TvButton(
                            text = "Reset",
                            enabled = serverInput != serverUrl,
                            onClick = { serverInput = serverUrl },
                        )
                    }
                    Spacer(Modifier.height(12.dp))
                    Text(
                        text = "Changing the server disconnects this TV and asks for a new pairing code.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = StreamLiftMuted.copy(alpha = 0.8f),
                    )
                }
            }

            item {
                SettingsCard(title = "This TV") {
                    InfoRow("Name", deviceName ?: "Android TV")
                    InfoRow("Model", listOf(Build.MANUFACTURER, Build.MODEL).joinToString(" ").trim())
                    InfoRow("App version", BuildConfig.VERSION_NAME)
                    InfoRow("Server", serverUrl)
                }
            }

            item {
                SettingsCard(title = "Playback") {
                    Text(
                        text = "Continue watching is stored only on this TV. Clearing it does not delete any files.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = StreamLiftMuted,
                    )
                    Spacer(Modifier.height(14.dp))
                    TvButton(
                        text = if (resumeCleared) "Continue watching cleared" else "Clear continue watching",
                        icon = Icons.Filled.DeleteSweep,
                        enabled = !resumeCleared,
                        onClick = {
                            onClearResume()
                            resumeCleared = true
                        },
                    )
                }
            }

            item {
                SettingsCard(title = "Connection") {
                    if (!confirmDisconnect) {
                        Text(
                            text = "Disconnecting removes this TV's access immediately. You will need a new code to connect it again.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = StreamLiftMuted,
                        )
                        Spacer(Modifier.height(14.dp))
                        TvButton(
                            text = "Disconnect this TV",
                            icon = Icons.Filled.LinkOff,
                            onClick = {
                                confirmDisconnect = true
                                scope.launch {
                                    delay(80)
                                    runCatching { confirmFocus.requestFocus() }
                                }
                            },
                            focusRequester = disconnectFocus,
                        )
                    } else {
                        Text(
                            text = "Disconnect this TV and show a new pairing code?",
                            style = MaterialTheme.typography.titleMedium,
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                        Spacer(Modifier.height(14.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            TvButton(
                                text = "Yes, disconnect",
                                primary = true,
                                onClick = onDisconnect,
                                focusRequester = confirmFocus,
                            )
                            TvButton(
                                text = "Cancel",
                                onClick = {
                                    confirmDisconnect = false
                                    scope.launch {
                                        delay(80)
                                        runCatching { disconnectFocus.requestFocus() }
                                    }
                                },
                            )
                        }
                    }
                }
            }

            item {
                Text(
                    text = "StreamLift TV only streams video and audio from your local workers. It cannot create downloads, torrents, or manage workers.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = StreamLiftMuted.copy(alpha = 0.7f),
                    modifier = Modifier.padding(vertical = 8.dp),
                )
            }
        }
    }
}

@Composable
private fun SettingsCard(
    title: String,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(StreamLiftSurface)
            .padding(24.dp),
    ) {
        Text(
            text = title,
            style = MaterialTheme.typography.titleLarge,
            color = MaterialTheme.colorScheme.onSurface,
        )
        Spacer(Modifier.height(12.dp))
        content()
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            color = StreamLiftMuted,
            modifier = Modifier.width(140.dp),
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
    }
}
