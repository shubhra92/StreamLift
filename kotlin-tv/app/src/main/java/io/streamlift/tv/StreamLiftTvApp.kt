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
            // Thumbnails live behind the worker tunnel. The image client reads
            // workerTunnelHeaders at request time (set on WorkerConnection fetch)
            // so no rebuild is needed when the tunnel provider changes.
            .okHttpClient { container.imageClient }
            .crossfade(true)
            .build()
    }
}
