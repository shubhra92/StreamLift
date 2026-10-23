package io.streamlift.tv.data

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

@Serializable
data class ResumeEntry(
    val key: String,
    val workerId: String,
    val workerName: String,
    val downloadId: String,
    val fileIndex: Int,
    val name: String,
    val displayName: String,
    val kind: String,
    val positionMs: Long,
    val durationMs: Long,
    val updatedAt: Long,
)

/** Continue-watching history, keyed by the catalog's stable file key. */
class ResumeStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    fun get(key: String): ResumeEntry? = list().firstOrNull { it.key == key }

    fun list(): List<ResumeEntry> {
        val raw = prefs.getString(KEY_ENTRIES, null) ?: return emptyList()
        return runCatching { json.decodeFromString<List<ResumeEntry>>(raw) }
            .getOrElse {
                prefs.edit().remove(KEY_ENTRIES).apply()
                emptyList()
            }
    }

    fun save(entry: ResumeEntry) {
        if (entry.positionMs < MIN_POSITION_MS) {
            clear(entry.key)
            return
        }
        if (entry.durationMs > 0 && entry.positionMs >= entry.durationMs * 0.95) {
            clear(entry.key)
            return
        }

        val next = (list().filterNot { it.key == entry.key } + entry)
            .sortedByDescending { it.updatedAt }
            .take(MAX_ENTRIES)

        prefs.edit()
            .putString(KEY_ENTRIES, json.encodeToString(next))
            .apply()
    }

    fun clear(key: String) {
        val next = list().filterNot { it.key == key }
        prefs.edit().putString(KEY_ENTRIES, json.encodeToString(next)).apply()
    }

    fun clearAll() {
        prefs.edit().remove(KEY_ENTRIES).apply()
    }

    companion object {
        private const val PREFS_NAME = "streamlift_tv_resume"
        private const val KEY_ENTRIES = "entries"
        private const val MAX_ENTRIES = 80
        private const val MIN_POSITION_MS = 5_000L
    }
}
