package io.streamlift.tv

import android.app.Application
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import io.streamlift.tv.data.ApiException
import io.streamlift.tv.data.SettingsStore
import io.streamlift.tv.StreamLiftTvApp
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

enum class AppScreen {
    Loading,
    ServerSetup,
    Pairing,
    Library,
    Settings,
    ConnectionError,
}

data class AppState(
    val screen: AppScreen = AppScreen.Loading,
    val serverUrl: String = "",
    val deviceName: String? = null,
    val model: String? = null,
    val pairingCode: String? = null,
    val pairingExpiresInMs: Long = 0L,
    val pairingStarting: Boolean = false,
    val pairingPolling: Boolean = false,
    val pairingError: String? = null,
    val error: String? = null,
)

class AppViewModel(application: Application) : AndroidViewModel(application) {
    private val container = (application as StreamLiftTvApp).container
    private val _state = MutableStateFlow(AppState())
    val state: StateFlow<AppState> = _state.asStateFlow()

    private var pairingJob: Job? = null
    private var bootstrapJob: Job? = null

    init {
        bootstrap()
    }

    fun bootstrap() {
        bootstrapJob?.cancel()
        pairingJob?.cancel()

        val serverUrl = container.settings.serverUrl()
        _state.update {
            it.copy(serverUrl = serverUrl, error = null, pairingError = null)
        }

        if (serverUrl.isBlank()) {
            _state.update { it.copy(screen = AppScreen.ServerSetup) }
            return
        }

        if (container.tokenStore.getToken().isNullOrBlank()) {
            beginPairing()
            return
        }

        _state.update { it.copy(screen = AppScreen.Loading) }
        bootstrapJob = viewModelScope.launch {
            try {
                val me = container.api.getMe()
                _state.update {
                    it.copy(
                        screen = AppScreen.Library,
                        deviceName = me.device.name.ifBlank { container.settings.deviceLabel() },
                        model = me.device.model,
                    )
                }
            } catch (error: ApiException) {
                if (error.statusCode == 401) {
                    container.tokenStore.clearToken()
                    beginPairing()
                } else {
                    _state.update {
                        it.copy(
                            screen = AppScreen.ConnectionError,
                            error = error.message,
                        )
                    }
                }
            } catch (error: Exception) {
                _state.update {
                    it.copy(
                        screen = AppScreen.ConnectionError,
                        error = error.message ?: "Could not reach StreamLift.",
                    )
                }
            }
        }
    }

    fun retryPairing() {
        beginPairing()
    }

    private fun beginPairing() {
        pairingJob?.cancel()

        if (!container.settings.hasServerUrl()) {
            _state.update { it.copy(screen = AppScreen.ServerSetup) }
            return
        }

        _state.update {
            it.copy(
                screen = AppScreen.Pairing,
                pairingCode = null,
                pairingExpiresInMs = 0L,
                pairingStarting = true,
                pairingPolling = false,
                pairingError = null,
                error = null,
            )
        }

        pairingJob = viewModelScope.launch {
            val secret = container.tokenStore.getOrCreateDeviceSecret()
            val deviceName = container.settings.deviceLabel()
            val model = listOf(Build.MANUFACTURER, Build.MODEL)
                .filter { it.isNotBlank() }
                .joinToString(" ")
                .trim()

            val start = try {
                container.api.startPairing(
                    deviceSecret = secret,
                    deviceName = deviceName,
                    model = model.ifBlank { null },
                    appVersion = BuildConfig.VERSION_NAME,
                )
            } catch (error: Exception) {
                _state.update {
                    it.copy(
                        pairingStarting = false,
                        pairingPolling = false,
                        pairingError = error.message ?: "Could not start pairing.",
                    )
                }
                return@launch
            }

            if (!start.success || start.code.isBlank()) {
                _state.update {
                    it.copy(
                        pairingStarting = false,
                        pairingPolling = false,
                        pairingError = "StreamLift did not return a pairing code.",
                    )
                }
                return@launch
            }

            var remainingMs = start.expiresInMs.takeIf { it > 0 } ?: DEFAULT_CODE_TTL_MS
            val pollIntervalMs = start.pollIntervalMs.coerceIn(1_000L, 5_000L)

            _state.update {
                it.copy(
                    pairingCode = start.code,
                    pairingExpiresInMs = remainingMs,
                    pairingStarting = false,
                    pairingPolling = true,
                    pairingError = null,
                )
            }

            while (isActive) {
                if (_state.value.screen != AppScreen.Pairing) return@launch

                delay(pollIntervalMs)
                remainingMs -= pollIntervalMs
                _state.update {
                    it.copy(
                        pairingExpiresInMs = remainingMs.coerceAtLeast(0L),
                        pairingPolling = true,
                    )
                }

                if (remainingMs <= 0L) {
                    _state.update {
                        it.copy(
                            pairingCode = null,
                            pairingPolling = false,
                            pairingError = "This code expired. Start a new code.",
                        )
                    }
                    return@launch
                }

                val poll = try {
                    container.api.pollPairing(secret)
                } catch (error: Exception) {
                    // Pairing is a slow, tolerant wait: keep the code up and
                    // retry until the countdown ends.
                    _state.update {
                        it.copy(
                            pairingError = "Connection lost. Still trying…",
                            pairingPolling = true,
                        )
                    }
                    continue
                }

                when (poll.status) {
                    "approved" -> {
                        val token = poll.deviceToken
                        if (!token.isNullOrBlank()) {
                            container.tokenStore.saveToken(token)
                            _state.update {
                                it.copy(
                                    screen = AppScreen.Library,
                                    pairingCode = null,
                                    pairingPolling = false,
                                    pairingError = null,
                                    deviceName = poll.device?.name
                                        ?: deviceName,
                                )
                            }
                            return@launch
                        }
                    }

                    "pending" -> {
                        _state.update { it.copy(pairingError = null) }
                    }

                    "denied" -> {
                        _state.update {
                            it.copy(
                                pairingCode = null,
                                pairingPolling = false,
                                pairingError = "This TV was not approved. Start a new code.",
                            )
                        }
                        return@launch
                    }

                    "expired", "unknown" -> {
                        _state.update {
                            it.copy(
                                pairingCode = null,
                                pairingPolling = false,
                                pairingError = "This code is no longer valid. Start a new code.",
                            )
                        }
                        return@launch
                    }
                }
            }
        }
    }

    fun saveServer(value: String) {
        val normalized = SettingsStore.normalize(value)
        if (normalized.isBlank()) {
            _state.update { it.copy(error = "Enter your StreamLift server address.") }
            return
        }

        container.settings.setServerUrl(normalized)
        container.tokenStore.clearToken()
        _state.update {
            it.copy(
                serverUrl = normalized,
                error = null,
                deviceName = null,
                model = null,
            )
        }
        beginPairing()
    }

    fun openSettings() {
        // Opening settings hides the pairing screen; stop polling for the code
        // that is no longer on screen. Closing settings starts a fresh code.
        pairingJob?.cancel()
        _state.update { it.copy(screen = AppScreen.Settings, error = null) }
    }

    fun closeSettings() {
        when {
            !container.settings.hasServerUrl() ->
                _state.update { it.copy(screen = AppScreen.ServerSetup) }

            container.tokenStore.getToken().isNullOrBlank() ->
                beginPairing()

            else ->
                _state.update { it.copy(screen = AppScreen.Library) }
        }
    }

    fun disconnect() {
        pairingJob?.cancel()
        viewModelScope.launch {
            runCatching { container.api.deleteMe() }
            container.tokenStore.clearToken()
            _state.update {
                it.copy(
                    deviceName = null,
                    model = null,
                    pairingCode = null,
                    pairingError = null,
                )
            }
            beginPairing()
        }
    }

    fun onAuthExpired() {
        container.tokenStore.clearToken()
        beginPairing()
    }

    override fun onCleared() {
        pairingJob?.cancel()
        bootstrapJob?.cancel()
        super.onCleared()
    }

    companion object {
        private const val DEFAULT_CODE_TTL_MS = 10 * 60 * 1000L

        fun factory(application: Application): ViewModelProvider.Factory =
            object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T {
                    return AppViewModel(application) as T
                }
            }
    }
}
