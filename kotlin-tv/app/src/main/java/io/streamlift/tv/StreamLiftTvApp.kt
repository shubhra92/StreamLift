package io.streamlift.tv

import android.app.Application
import coil.ImageLoader
import coil.ImageLoaderFactory
import io.streamlift.tv.data.AppContainer

class StreamLiftTvApp : Application(), ImageLoaderFactory {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }

    override fun newImageLoader(): ImageLoader {
        return ImageLoader.Builder(this)
            // Thumbnails live behind the worker's Pinggy tunnel. The image
            // client adds X-Pinggy-No-Screen so Coil doesn't download the
            // tunnel's browser screening page instead of the JPEG.
            .okHttpClient { container.imageClient }
            .crossfade(true)
            .build()
    }
}
