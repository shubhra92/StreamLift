package io.streamlift.tv.ui

import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import io.streamlift.tv.AppScreen
import io.streamlift.tv.AppState
import io.streamlift.tv.AppViewModel
import io.streamlift.tv.PlayerActivity
import io.streamlift.tv.data.PlayerItem
import io.streamlift.tv.StreamLiftTvApp
import io.streamlift.tv.ui.library.LibraryScreen
import io.streamlift.tv.ui.pairing.PairingScreen
import io.streamlift.tv.ui.settings.SettingsScreen

@Composable
fun AppRoot(
    state: AppState,
    appViewModel: AppViewModel,
) {
    val context = LocalContext.current
    val app = context.applicationContext as StreamLiftTvApp

    when (state.screen) {
        AppScreen.Loading -> LoadingScreen()

        AppScreen.ServerSetup -> ServerSetupScreen(
            initialValue = state.serverUrl,
            error = state.error,
            onSave = appViewModel::saveServer,
        )

        AppScreen.Pairing -> PairingScreen(
            state = state,
            onRetry = appViewModel::retryPairing,
            onOpenSettings = appViewModel::openSettings,
        )

        AppScreen.Library -> LibraryScreen(
            deviceName = state.deviceName,
            onPlay = { item, items -> startPlayer(context, item, items) },
            onOpenSettings = appViewModel::openSettings,
            onAuthExpired = appViewModel::onAuthExpired,
        )

        AppScreen.Settings -> SettingsScreen(
            serverUrl = state.serverUrl,
            deviceName = state.deviceName,
            onSaveServer = appViewModel::saveServer,
            onDisconnect = appViewModel::disconnect,
            onClearResume = { app.container.resumeStore.clearAll() },
            onBack = appViewModel::closeSettings,
        )

        AppScreen.ConnectionError -> ConnectionErrorScreen(
            message = state.error,
            onRetry = appViewModel::bootstrap,
            onOpenSettings = appViewModel::openSettings,
        )
    }
}

private fun startPlayer(
    context: android.content.Context,
    item: PlayerItem,
    items: List<PlayerItem>,
) {
    val intent = PlayerActivity.createIntent(context, item, items)
    context.startActivity(intent)
    if (context is android.app.Activity) {
        context.overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out)
    }
}
