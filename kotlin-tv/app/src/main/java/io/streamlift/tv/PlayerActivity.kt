package io.streamlift.tv

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import io.streamlift.tv.data.PlayerItem
import io.streamlift.tv.StreamLiftTvApp
import io.streamlift.tv.ui.player.PlayerScreen
import io.streamlift.tv.ui.player.PlayerViewModel
import io.streamlift.tv.ui.theme.StreamLiftTheme
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString

class PlayerActivity : ComponentActivity() {
    private val viewModel: PlayerViewModel by viewModels {
        val app = application as StreamLiftTvApp
        val itemsJson = intent.getStringExtra(EXTRA_ITEMS) ?: "[]"
        val items = runCatching {
            app.container.json.decodeFromString<List<PlayerItem>>(itemsJson)
        }.getOrDefault(emptyList())
        val startKey = intent.getStringExtra(EXTRA_START_KEY)
        val startIndex = items.indexOfFirst { it.key == startKey }.coerceAtLeast(0)

        PlayerViewModel.Factory(
            application = application,
            container = app.container,
            items = items,
            startIndex = startIndex,
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        hideSystemBars()

        setContent {
            StreamLiftTheme {
                PlayerScreen(
                    viewModel = viewModel,
                    onExit = { finish() },
                )
            }
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    override fun onStop() {
        viewModel.pauseAndSave()
        super.onStop()
    }

    override fun finish() {
        super.finish()
        overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out)
    }

    private fun hideSystemBars() {
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.hide(WindowInsetsCompat.Type.systemBars())
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }

    companion object {
        private const val EXTRA_ITEMS = "items"
        private const val EXTRA_START_KEY = "start_key"

        fun createIntent(
            context: Context,
            item: PlayerItem,
            items: List<PlayerItem>,
        ): Intent {
            val app = context.applicationContext as StreamLiftTvApp
            return Intent(context, PlayerActivity::class.java).apply {
                putExtra(EXTRA_ITEMS, app.container.json.encodeToString(items))
                putExtra(EXTRA_START_KEY, item.key)
            }
        }
    }
}
