package io.streamlift.tv.ui.library

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import io.streamlift.tv.data.ApiException
import io.streamlift.tv.data.AppContainer
import io.streamlift.tv.data.CatalogFile
import io.streamlift.tv.data.CatalogGroup
import io.streamlift.tv.data.CatalogWorker
import io.streamlift.tv.data.ResumeStore
import io.streamlift.tv.data.StreamLiftApi
import io.streamlift.tv.data.UnreachableWorker
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class ContinueWatchingItem(
    val file: CatalogFile,
    val worker: CatalogWorker,
    val positionMs: Long,
    val durationMs: Long,
)

data class LibraryUiState(
    val loading: Boolean = true,
    val refreshing: Boolean = false,
    val groups: List<CatalogGroup> = emptyList(),
    val unreachableWorkers: List<UnreachableWorker> = emptyList(),
    val continueWatching: List<ContinueWatchingItem> = emptyList(),
    val error: String? = null,
    val lastUpdated: Long = 0L,
)

class LibraryViewModel(
    private val api: StreamLiftApi,
    private val resumeStore: ResumeStore,
) : ViewModel() {
    private val _state = MutableStateFlow(LibraryUiState())
    val state: StateFlow<LibraryUiState> = _state.asStateFlow()

    private val _authExpired = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val authExpired: SharedFlow<Unit> = _authExpired.asSharedFlow()

    private var refreshJob: Job? = null

    init {
        refresh(force = true)
    }

    fun refresh(force: Boolean = false) {
        if (refreshJob?.isActive == true) return

        refreshJob = viewModelScope.launch {
            val hasContent = _state.value.groups.isNotEmpty()
            _state.update {
                it.copy(
                    loading = !hasContent,
                    refreshing = hasContent,
                    error = null,
                )
            }

            try {
                val catalog = api.getCatalog(force)
                val fileIndex = HashMap<String, Pair<CatalogWorker, CatalogFile>>()
                catalog.groups.forEach { group ->
                    group.files.forEach { file ->
                        fileIndex[file.key] = group.worker to file
                    }
                }

                val continueWatching = resumeStore.list()
                    .sortedByDescending { it.updatedAt }
                    .mapNotNull { entry ->
                        val (worker, file) = fileIndex[entry.key] ?: return@mapNotNull null
                        if (entry.durationMs > 0 && entry.positionMs >= entry.durationMs * 0.95) {
                            return@mapNotNull null
                        }
                        ContinueWatchingItem(
                            file = file,
                            worker = worker,
                            positionMs = entry.positionMs,
                            durationMs = entry.durationMs,
                        )
                    }
                    .distinctBy { it.file.key }
                    .take(12)

                _state.update {
                    it.copy(
                        loading = false,
                        refreshing = false,
                        groups = catalog.groups,
                        unreachableWorkers = catalog.unreachableWorkers,
                        continueWatching = continueWatching,
                        error = null,
                        lastUpdated = System.currentTimeMillis(),
                    )
                }
            } catch (error: ApiException) {
                if (error.statusCode == 401) {
                    _authExpired.tryEmit(Unit)
                    _state.update { it.copy(loading = false, refreshing = false) }
                } else {
                    _state.update {
                        it.copy(
                            loading = false,
                            refreshing = false,
                            error = error.message,
                        )
                    }
                }
            } catch (error: Exception) {
                _state.update {
                    it.copy(
                        loading = false,
                        refreshing = false,
                        error = error.message ?: "Could not load your watch library.",
                    )
                }
            }
        }
    }

    class Factory(private val container: AppContainer) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            return LibraryViewModel(container.api, container.resumeStore) as T
        }
    }
}
