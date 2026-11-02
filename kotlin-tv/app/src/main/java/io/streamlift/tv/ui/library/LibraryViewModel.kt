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
import io.streamlift.tv.data.RenderQuality
import io.streamlift.tv.data.StreamLiftApi
import io.streamlift.tv.data.UnreachableWorker
import io.streamlift.tv.data.WorkerApi
import io.streamlift.tv.data.WorkerConnection
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
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

data class RenderSheetState(
    val worker: CatalogWorker,
    val file: CatalogFile,
    val loading: Boolean = true,
    val busy: Boolean = false,
    val error: String? = null,
    val qualities: List<RenderQuality> = emptyList(),
    val renderedBytes: Long = 0,
    val freeBytes: Long? = null,
    val selected: Set<String> = emptySet(),
) {
    val renderedCount: Int get() = qualities.count { it.rendered }
}

class LibraryViewModel(
    private val api: StreamLiftApi,
    private val resumeStore: ResumeStore,
    private val workerApi: WorkerApi,
) : ViewModel() {
    private val _state = MutableStateFlow(LibraryUiState())
    val state: StateFlow<LibraryUiState> = _state.asStateFlow()

    private val _authExpired = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val authExpired: SharedFlow<Unit> = _authExpired.asSharedFlow()

    private val _renderSheet = MutableStateFlow<RenderSheetState?>(null)
    val renderSheet: StateFlow<RenderSheetState?> = _renderSheet.asStateFlow()

    private var refreshJob: Job? = null
    private var renderPollJob: Job? = null
    private var renderConnection: WorkerConnection? = null

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

    fun openRenderSheet(worker: CatalogWorker, file: CatalogFile) {
        renderPollJob?.cancel()
        renderConnection = null
        _renderSheet.value = RenderSheetState(worker = worker, file = file)

        renderPollJob = viewModelScope.launch {
            try {
                renderConnection = api.getWorkerConnection(worker.id)
            } catch (error: Exception) {
                _renderSheet.update {
                    it?.copy(
                        loading = false,
                        error = error.message ?: "Could not reach this worker.",
                    )
                }
                return@launch
            }
            while (isActive) {
                refreshRenderState()
                delay(1500)
            }
        }
    }

    fun closeRenderSheet() {
        renderPollJob?.cancel()
        renderPollJob = null
        renderConnection = null
        _renderSheet.value = null
    }

    fun toggleRenderQuality(id: String) {
        _renderSheet.update { current ->
            current ?: return@update null
            val selection = if (id in current.selected) {
                current.selected - id
            } else {
                current.selected + id
            }
            current.copy(selected = selection)
        }
    }

    fun startSelectedRenders() {
        val sheet = _renderSheet.value ?: return
        if (sheet.selected.isEmpty() || sheet.busy) return
        viewModelScope.launch {
            _renderSheet.update { it?.copy(busy = true, error = null) }
            try {
                val connection = renderConnection
                    ?: api.getWorkerConnection(sheet.worker.id).also {
                        renderConnection = it
                    }
                val state = workerApi.startRenders(
                    baseUrl = connection.tunnelUrl,
                    sessionToken = connection.sessionToken,
                    downloadId = sheet.file.downloadId,
                    fileIndex = sheet.file.fileIndex,
                    qualities = sheet.selected.toList(),
                    tunnelHeaders = connection.tunnelHeaders,
                )
                _renderSheet.update { current ->
                    current?.copy(
                        busy = false,
                        selected = emptySet(),
                        qualities = state.qualities,
                        renderedBytes = state.renderedBytes,
                        freeBytes = state.freeBytes,
                    )
                }
            } catch (error: Exception) {
                _renderSheet.update {
                    it?.copy(
                        busy = false,
                        error = error.message ?: "Could not start the pre-render.",
                    )
                }
            }
        }
    }

    fun cancelRender(quality: String) {
        val sheet = _renderSheet.value ?: return
        if (sheet.busy) return
        viewModelScope.launch {
            _renderSheet.update { it?.copy(busy = true, error = null) }
            try {
                val connection = renderConnection ?: return@launch
                val state = workerApi.cancelRender(
                    baseUrl = connection.tunnelUrl,
                    sessionToken = connection.sessionToken,
                    downloadId = sheet.file.downloadId,
                    fileIndex = sheet.file.fileIndex,
                    quality = quality,
                    tunnelHeaders = connection.tunnelHeaders,
                )
                _renderSheet.update { current ->
                    current?.copy(
                        busy = false,
                        qualities = state.qualities,
                        renderedBytes = state.renderedBytes,
                        freeBytes = state.freeBytes,
                    )
                }
            } catch (error: Exception) {
                _renderSheet.update {
                    it?.copy(
                        busy = false,
                        error = error.message ?: "Could not cancel the pre-render.",
                    )
                }
            }
        }
    }

    fun deleteRender(quality: String) {
        val sheet = _renderSheet.value ?: return
        if (sheet.busy) return
        viewModelScope.launch {
            _renderSheet.update { it?.copy(busy = true, error = null) }
            try {
                val connection = renderConnection ?: return@launch
                val state = workerApi.deleteRender(
                    baseUrl = connection.tunnelUrl,
                    sessionToken = connection.sessionToken,
                    downloadId = sheet.file.downloadId,
                    fileIndex = sheet.file.fileIndex,
                    quality = quality,
                    tunnelHeaders = connection.tunnelHeaders,
                )
                _renderSheet.update { current ->
                    current?.copy(
                        busy = false,
                        qualities = state.qualities,
                        renderedBytes = state.renderedBytes,
                        freeBytes = state.freeBytes,
                    )
                }
            } catch (error: Exception) {
                _renderSheet.update {
                    it?.copy(
                        busy = false,
                        error = error.message ?: "Could not delete the pre-render.",
                    )
                }
            }
        }
    }

    private suspend fun refreshRenderState() {
        val sheet = _renderSheet.value ?: return
        val connection = renderConnection ?: return
        try {
            val state = workerApi.renderState(
                baseUrl = connection.tunnelUrl,
                sessionToken = connection.sessionToken,
                downloadId = sheet.file.downloadId,
                fileIndex = sheet.file.fileIndex,
                tunnelHeaders = connection.tunnelHeaders,
            )
            _renderSheet.update { current ->
                current?.takeIf { it.file.key == sheet.file.key }?.copy(
                    loading = false,
                    error = null,
                    qualities = state.qualities,
                    renderedBytes = state.renderedBytes,
                    freeBytes = state.freeBytes,
                )
            }
        } catch (error: Exception) {
            _renderSheet.update { current ->
                current?.takeIf { it.file.key == sheet.file.key }?.copy(
                    loading = false,
                    error = error.message ?: "Could not read pre-render status.",
                )
            }
        }
    }

    class Factory(private val container: AppContainer) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            return LibraryViewModel(
                container.api,
                container.resumeStore,
                container.workerApi,
            ) as T
        }
    }
}
