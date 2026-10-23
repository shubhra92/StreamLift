package io.streamlift.tv.data

import android.content.Context
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient

class AppContainer(context: Context) {
    val settings = SettingsStore(context)
    val tokenStore = TokenStore(context)
    val resumeStore = ResumeStore(context)

    val json: Json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
    }

    val okHttpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(35, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .build()

    /** Coil's client. Pinggy serves a screening page without this header. */
    val imageClient: OkHttpClient = okHttpClient.newBuilder()
        .addInterceptor { chain ->
            chain.proceed(
                chain.request().newBuilder()
                    .header("X-Pinggy-No-Screen", "1")
                    .header("User-Agent", "StreamLiftTV")
                    .build(),
            )
        }
        .build()

    val api = StreamLiftApi(settings, tokenStore, okHttpClient, json)
    val workerApi = WorkerApi(okHttpClient, json)
}
