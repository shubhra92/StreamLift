package io.streamlift.tv

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.streamlift.tv.data.PlayerItem
import io.streamlift.tv.StreamLiftTvApp
import io.streamlift.tv.ui.AppRoot
import io.streamlift.tv.ui.ConnectionErrorScreen
import io.streamlift.tv.ui.LoadingScreen
import io.streamlift.tv.ui.ServerSetupScreen
import io.streamlift.tv.ui.library.LibraryScreen
import io.streamlift.tv.ui.pairing.PairingScreen
import io.streamlift.tv.ui.settings.SettingsScreen
import io.streamlift.tv.ui.theme.StreamLiftTheme

class MainActivity : ComponentActivity() {
    private val viewModel: AppViewModel by viewModels {
        AppViewModel.factory(application)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        hideSystemBars()

        setContent {
            StreamLiftTheme {
                val state by viewModel.state.collectAsStateWithLifecycle()
                AppRoot(
                    state = state,
                    appViewModel = viewModel,
                )
            }
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    private fun hideSystemBars() {
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.hide(WindowInsetsCompat.Type.systemBars())
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }
}
