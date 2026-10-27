package io.streamlift.tv.data

import android.content.Context
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request

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

    /** Coil's image client. Reads tunnelHeaders at request time so updating
     *  the stored connection is enough — no client rebuild needed. */
    @Volatile var workerTunnelHeaders: Map<String, String> = emptyMap()

    val imageClient: OkHttpClient = okHttpClient.newBuilder()
        .addInterceptor { chain ->
            val req = chain.request().newBuilder()
                .apply { workerTunnelHeaders.forEach { (k, v) -> header(k, v) } }
                .header("User-Agent", "StreamLiftTV")
                .build()
            chain.proceed(req)
        }
        .build()

    val api = StreamLiftApi(settings, tokenStore, okHttpClient, json)
    val workerApi = WorkerApi(okHttpClient, json)
}
