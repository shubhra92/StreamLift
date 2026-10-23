package io.streamlift.tv.ui

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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import io.streamlift.tv.ui.components.ScreenBackground
import io.streamlift.tv.ui.components.StreamLiftLogo
import io.streamlift.tv.ui.components.TvButton
import io.streamlift.tv.ui.components.TvTextField
import io.streamlift.tv.ui.theme.StreamLiftAccent
import io.streamlift.tv.ui.theme.StreamLiftMuted
import io.streamlift.tv.ui.theme.StreamLiftSurface
import kotlinx.coroutines.delay

@Composable
fun LoadingScreen() {
    ScreenBackground {
        Column(
            modifier = Modifier.align(Alignment.Center),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            StreamLiftLogo()
            Spacer(Modifier.height(28.dp))
            CircularProgressIndicator(
                color = StreamLiftAccent,
                strokeWidth = 3.dp,
                modifier = Modifier.size(34.dp),
            )
        }
    }
}

@Composable
fun ServerSetupScreen(
    initialValue: String,
    error: String?,
    onSave: (String) -> Unit,
) {
    var value by rememberSaveable(initialValue) { mutableStateOf(initialValue) }
    val fieldFocus = remember { FocusRequester() }

    LaunchedEffect(Unit) {
        delay(250)
        runCatching { fieldFocus.requestFocus() }
    }

    ScreenBackground {
        Column(
            modifier = Modifier
                .align(Alignment.Center)
                .widthIn(max = 780.dp)
                .padding(48.dp)
                .verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            StreamLiftLogo()
            Spacer(Modifier.height(36.dp))
            Text(
                text = "Connect to StreamLift",
                style = MaterialTheme.typography.headlineLarge,
                color = MaterialTheme.colorScheme.onBackground,
            )
            Spacer(Modifier.height(12.dp))
            Text(
                text = "Enter the address of your StreamLift web app. This TV will use it for pairing and for your watch library.",
                style = MaterialTheme.typography.bodyLarge,
                color = StreamLiftMuted,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(32.dp))

            TvTextField(
                value = value,
                onValueChange = { value = it },
                label = "Server URL",
                placeholder = "https://streamlift.example.com",
                focusRequester = fieldFocus,
            )

            if (error != null) {
                Spacer(Modifier.height(12.dp))
                Text(
                    text = error,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }

            Spacer(Modifier.height(24.dp))
            TvButton(
                text = "Continue",
                onClick = { onSave(value) },
                primary = true,
            )
            Spacer(Modifier.height(24.dp))
            Text(
                text = "You can change this later in Settings.",
                style = MaterialTheme.typography.bodyMedium,
                color = StreamLiftMuted.copy(alpha = 0.8f),
            )
        }
    }
}

@Composable
fun ConnectionErrorScreen(
    message: String?,
    onRetry: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val retryFocus = remember { FocusRequester() }

    LaunchedEffect(Unit) {
        delay(200)
        runCatching { retryFocus.requestFocus() }
    }

    ScreenBackground {
        Column(
            modifier = Modifier
                .align(Alignment.Center)
                .widthIn(max = 680.dp)
                .padding(48.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box(
                modifier = Modifier
                    .size(76.dp)
                    .clip(RoundedCornerShape(22.dp))
                    .background(StreamLiftSurface),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = Icons.Filled.CloudOff,
                    contentDescription = null,
                    tint = StreamLiftAccent,
                    modifier = Modifier.size(36.dp),
                )
            }
            Spacer(Modifier.height(28.dp))
            Text(
                text = "Can't reach StreamLift",
                style = MaterialTheme.typography.headlineLarge,
                color = MaterialTheme.colorScheme.onBackground,
            )
            Spacer(Modifier.height(12.dp))
            Text(
                text = message ?: "Check that the StreamLift server is running and that this TV is online.",
                style = MaterialTheme.typography.bodyLarge,
                color = StreamLiftMuted,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(32.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                TvButton(
                    text = "Try again",
                    icon = Icons.Filled.Refresh,
                    primary = true,
                    onClick = onRetry,
                    focusRequester = retryFocus,
                )
                TvButton(
                    text = "Server settings",
                    icon = Icons.Filled.Settings,
                    onClick = onOpenSettings,
                )
            }
        }
    }
}

@Composable
fun ErrorMessageCard(message: String, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.error.copy(alpha = 0.12f))
            .padding(horizontal = 18.dp, vertical = 14.dp),
    ) {
        Text(
            text = message,
            color = MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}
