package io.streamlift.tv.data

import android.content.Context
import io.streamlift.tv.BuildConfig

/**
 * Small, synchronous settings store for the handful of values the TV needs
 * before the first frame. The server URL is baked in from
 * `streamlift.server.url` at build time and can be overridden here at runtime.
 */
class SettingsStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun serverUrl(): String {
        val stored = prefs.getString(KEY_SERVER_URL, null)
        val raw = if (!stored.isNullOrBlank()) stored else BuildConfig.DEFAULT_SERVER_URL
        return normalize(raw)
    }

    fun hasServerUrl(): Boolean = serverUrl().isNotBlank()

    fun setServerUrl(value: String): String {
        val normalized = normalize(value)
        prefs.edit().putString(KEY_SERVER_URL, normalized).apply()
        return normalized
    }

    fun clearServerUrl() {
        prefs.edit().remove(KEY_SERVER_URL).apply()
    }

    fun deviceLabel(): String {
        return prefs.getString(KEY_DEVICE_LABEL, null)?.takeIf { it.isNotBlank() }
            ?: android.os.Build.MODEL
            ?: "Android TV"
    }

    fun setDeviceLabel(value: String) {
        prefs.edit().putString(KEY_DEVICE_LABEL, value.trim().take(48)).apply()
    }

    companion object {
        private const val PREFS_NAME = "streamlift_tv_settings"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_DEVICE_LABEL = "device_label"

        fun normalize(raw: String): String {
            val trimmed = raw.trim().trimEnd('/')
            if (trimmed.isBlank()) return ""
            return when {
                trimmed.startsWith("https://", ignoreCase = true) -> trimmed
                trimmed.startsWith("http://", ignoreCase = true) -> trimmed
                else -> "https://$trimmed"
            }
        }
    }
}
