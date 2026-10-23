package io.streamlift.tv.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import io.streamlift.tv.ui.theme.StreamLiftAccent
import io.streamlift.tv.ui.theme.StreamLiftBackground
import io.streamlift.tv.ui.theme.StreamLiftFocusOutline
import io.streamlift.tv.ui.theme.StreamLiftFocusSecondaryText
import io.streamlift.tv.ui.theme.StreamLiftFocusSurface
import io.streamlift.tv.ui.theme.StreamLiftMuted
import io.streamlift.tv.ui.theme.StreamLiftNeutralSurface
import io.streamlift.tv.ui.theme.StreamLiftSelectedSurface
import io.streamlift.tv.ui.theme.StreamLiftSurface

@Composable
fun ScreenBackground(content: @Composable BoxScope.() -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(
                    listOf(
                        Color(0xFF04070C),
                        StreamLiftBackground,
                        Color(0xFF0A111C),
                    ),
                ),
            ),
        content = content,
    )
}

/**
 * The single source of truth for TV focus surfaces.
 *
 * It deliberately applies exactly one clip, one background, and one thin
 * outline. Do not add a shadow or a second background inside a focusable
 * component: on a 10-foot screen that reads as a stacked, muddy state.
 */
@Composable
fun Modifier.tvFocusSurface(
    focused: Boolean,
    shape: Shape,
    selected: Boolean = false,
    focusedColor: Color = StreamLiftFocusSurface,
    selectedColor: Color = StreamLiftSelectedSurface,
    unfocusedColor: Color = Color.Transparent,
    outlineColor: Color = StreamLiftFocusOutline,
): Modifier {
    val background by animateColorAsState(
        targetValue = when {
            focused -> focusedColor
            selected -> selectedColor
            else -> unfocusedColor
        },
        animationSpec = tween(durationMillis = 120),
        label = "tvFocusBackground",
    )
    val outline by animateColorAsState(
        targetValue = if (focused) outlineColor else Color.Transparent,
        animationSpec = tween(durationMillis = 120),
        label = "tvFocusOutline",
    )
    return this
        .clip(shape)
        .background(background)
        .border(2.dp, outline, shape)
}

@Composable
fun StreamLiftLogo(
    modifier: Modifier = Modifier,
    compact: Boolean = false,
) {
    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(if (compact) 34.dp else 44.dp)
                .clip(CircleShape)
                .background(StreamLiftAccent),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = Icons.Filled.PlayArrow,
                contentDescription = null,
                tint = Color(0xFF04101F),
                modifier = Modifier.size(if (compact) 22.dp else 28.dp),
            )
        }
        Spacer(Modifier.width(10.dp))
        Text(
            text = "StreamLift",
            style = if (compact) MaterialTheme.typography.titleLarge else MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.onBackground,
        )
        Spacer(Modifier.width(8.dp))
        Box(
            modifier = Modifier
                .clip(RoundedCornerShape(6.dp))
                .background(StreamLiftAccent.copy(alpha = 0.18f))
                .padding(horizontal = 8.dp, vertical = 3.dp),
        ) {
            Text(
                text = "TV",
                color = StreamLiftAccent,
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.sp,
            )
        }
    }
}

@Composable
fun TvButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    primary: Boolean = false,
    compact: Boolean = false,
    enabled: Boolean = true,
    focusRequester: FocusRequester? = null,
) {
    var focused by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(12.dp)
    val scale by animateFloatAsState(
        targetValue = if (focused) 1.02f else 1f,
        animationSpec = tween(durationMillis = 120),
        label = "tvButtonScale",
    )
    val contentColor by animateColorAsState(
        targetValue = when {
            focused -> Color.White
            primary -> MaterialTheme.colorScheme.onPrimary
            else -> MaterialTheme.colorScheme.onSurface
        },
        animationSpec = tween(durationMillis = 120),
        label = "tvButtonContent",
    )
    val unfocusedColor = when {
        !enabled -> MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f)
        primary -> MaterialTheme.colorScheme.primary
        else -> StreamLiftNeutralSurface
    }
    val interaction = remember { MutableInteractionSource() }

    Row(
        modifier = modifier
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .alpha(if (enabled) 1f else 0.5f)
            .tvFocusSurface(
                focused = focused,
                shape = shape,
                unfocusedColor = unfocusedColor,
            )
            .then(
                if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier,
            )
            .onFocusChanged { focused = it.isFocused }
            .clickable(
                enabled = enabled,
                interactionSource = interaction,
                indication = null,
                onClick = onClick,
            )
            .padding(
                horizontal = if (compact) 14.dp else 22.dp,
                vertical = if (compact) 10.dp else 14.dp,
            ),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (icon != null) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = contentColor,
                modifier = Modifier.size(if (compact) 18.dp else 21.dp),
            )
        }
        Text(
            text = text,
            color = contentColor,
            style = if (compact) MaterialTheme.typography.labelMedium else MaterialTheme.typography.labelLarge,
            maxLines = 1,
        )
    }
}

@Composable
fun TvIconButton(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    focusRequester: FocusRequester? = null,
    loading: Boolean = false,
) {
    var focused by remember { mutableStateOf(false) }
    val interaction = remember { MutableInteractionSource() }
    val scale by animateFloatAsState(
        targetValue = if (focused) 1.04f else 1f,
        animationSpec = tween(durationMillis = 120),
        label = "tvIconButtonScale",
    )

    Box(
        modifier = modifier
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .size(48.dp)
            .tvFocusSurface(
                focused = focused,
                shape = CircleShape,
            )
            .then(
                if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier,
            )
            .onFocusChanged { focused = it.isFocused }
            .clickable(
                interactionSource = interaction,
                indication = null,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        if (loading) {
            CircularProgressIndicator(
                color = if (focused) Color.White else MaterialTheme.colorScheme.primary,
                strokeWidth = 2.dp,
                modifier = Modifier.size(22.dp),
            )
        } else {
            Icon(
                imageVector = icon,
                contentDescription = contentDescription,
                tint = if (focused) Color.White else MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.size(24.dp),
            )
        }
    }
}

@Composable
fun TvTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    placeholder: String,
    modifier: Modifier = Modifier,
    focusRequester: FocusRequester? = null,
) {
    val focusManager = LocalFocusManager.current
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        placeholder = { Text(placeholder, color = StreamLiftMuted.copy(alpha = 0.65f)) },
        singleLine = true,
        shape = RoundedCornerShape(12.dp),
        textStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = 20.sp),
        keyboardOptions = KeyboardOptions(
            keyboardType = KeyboardType.Uri,
            imeAction = ImeAction.Done,
        ),
        keyboardActions = KeyboardActions(
            onDone = { focusManager.clearFocus() },
        ),
        colors = OutlinedTextFieldDefaults.colors(
            focusedTextColor = Color.White,
            unfocusedTextColor = MaterialTheme.colorScheme.onSurface,
            focusedBorderColor = StreamLiftFocusOutline,
            unfocusedBorderColor = MaterialTheme.colorScheme.outline,
            focusedContainerColor = StreamLiftSurface,
            unfocusedContainerColor = StreamLiftSurface,
            focusedLabelColor = StreamLiftFocusSecondaryText,
            unfocusedLabelColor = StreamLiftMuted,
            cursorColor = StreamLiftFocusOutline,
        ),
        modifier = modifier
            .fillMaxWidth()
            .then(
                if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier,
            ),
    )
}

@Composable
fun SectionHeader(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        androidx.compose.foundation.layout.Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleLarge,
                color = MaterialTheme.colorScheme.onBackground,
            )
            if (subtitle != null) {
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (trailing != null) {
            Spacer(Modifier.width(12.dp))
            trailing()
        }
    }
}

val ContentPadding = PaddingValues(horizontal = 48.dp)
