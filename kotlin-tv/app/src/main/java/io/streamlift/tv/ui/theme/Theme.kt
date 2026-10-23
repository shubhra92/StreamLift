package io.streamlift.tv.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

val StreamLiftBackground = Color(0xFF05080D)
val StreamLiftSurface = Color(0xFF0F141C)
val StreamLiftSurfaceVariant = Color(0xFF1A2230)
val StreamLiftAccent = Color(0xFF5B9DFF)
val StreamLiftMuted = Color(0xFFAAB7C8)
val StreamLiftOutline = Color(0xFF2B3646)

// TV focus system. Focus is deliberately blue-only: one surface fill, one
// thin outline, and no colored shadow that can read as a second background.
val StreamLiftFocusSurface = Color(0xFF193B62)
val StreamLiftFocusOutline = Color(0xFF65B8FF)
val StreamLiftSelectedSurface = Color(0xFF12243B)
val StreamLiftNeutralSurface = Color(0xFF171B26)
val StreamLiftFocusSecondaryText = Color(0xFFAFC9E6)

private val StreamLiftColorScheme = darkColorScheme(
    primary = StreamLiftAccent,
    onPrimary = Color(0xFF04101F),
    primaryContainer = Color(0xFF16345C),
    onPrimaryContainer = Color(0xFFD8E7FF),
    secondary = Color(0xFF9DC1FF),
    onSecondary = Color(0xFF04101F),
    background = StreamLiftBackground,
    onBackground = Color(0xFFF2F5FA),
    surface = StreamLiftSurface,
    onSurface = Color(0xFFF2F5FA),
    surfaceVariant = StreamLiftSurfaceVariant,
    onSurfaceVariant = StreamLiftMuted,
    outline = StreamLiftOutline,
    error = Color(0xFFFF6B6B),
    onError = Color(0xFF1B0505),
)

private val base = Typography()

private val StreamLiftTypography = Typography(
    displayLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Bold,
        fontSize = 54.sp,
        lineHeight = 62.sp,
        letterSpacing = (-1.5).sp,
    ),
    displayMedium = base.displayMedium.copy(
        fontSize = 44.sp,
        lineHeight = 52.sp,
        fontWeight = FontWeight.Bold,
    ),
    headlineLarge = base.headlineLarge.copy(
        fontSize = 34.sp,
        lineHeight = 42.sp,
        fontWeight = FontWeight.Bold,
    ),
    headlineMedium = base.headlineMedium.copy(
        fontSize = 28.sp,
        lineHeight = 36.sp,
        fontWeight = FontWeight.SemiBold,
    ),
    titleLarge = base.titleLarge.copy(
        fontSize = 24.sp,
        lineHeight = 30.sp,
        fontWeight = FontWeight.SemiBold,
    ),
    titleMedium = base.titleMedium.copy(
        fontSize = 20.sp,
        lineHeight = 26.sp,
        fontWeight = FontWeight.SemiBold,
    ),
    bodyLarge = base.bodyLarge.copy(
        fontSize = 18.sp,
        lineHeight = 26.sp,
    ),
    bodyMedium = base.bodyMedium.copy(
        fontSize = 16.sp,
        lineHeight = 23.sp,
    ),
    labelLarge = base.labelLarge.copy(
        fontSize = 15.sp,
        lineHeight = 20.sp,
        fontWeight = FontWeight.SemiBold,
    ),
    labelMedium = base.labelMedium.copy(
        fontSize = 13.sp,
        lineHeight = 18.sp,
        fontWeight = FontWeight.Medium,
    ),
)

@Composable
fun StreamLiftTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = StreamLiftColorScheme,
        typography = StreamLiftTypography,
        content = content,
    )
}
