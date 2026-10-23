package io.streamlift.tv.data

import android.net.Uri
import io.streamlift.tv.BuildConfig
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class ApiException(
    val statusCode: Int,
    override val message: String,
) : Exception(message)

/**
 * Client for the Next.js TV API. Uses OkHttp directly so the server URL can be
 * changed at runtime without rebuilding a Retrofit instance.
 */
class StreamLiftApi(
    private val settings: SettingsStore,
    private val tokenStore: TokenStore,
    private val client: OkHttpClient = defaultClient(),
    private val json: Json = Json { ignoreUnknownKeys = true; isLenient = true },
) {
    fun serverUrl(): String = settings.serverUrl()

    suspend fun startPairing(
        deviceSecret: String,
        deviceName: String?,
        model: String?,
        appVersion: String?,
    ): PairStartResponse {
        val payload = json.encodeToString(
            PairStartRequest(
                deviceSecret = deviceSecret,
                deviceName = deviceName,
                model = model,
                appVersion = appVersion,
            ),
        )
        val request = Request.Builder()
            .url("${baseUrl()}/api/tv/pair/start")
            .header("Accept", "application/json")
            .header("User-Agent", userAgent())
            .post(payload.toRequestBody(JSON_MEDIA))
            .build()
        return json.decodeFromString(execute(request))
    }

    suspend fun pollPairing(deviceSecret: String): PairPollResponse {
        val request = Request.Builder()
            .url("${baseUrl()}/api/tv/pair/poll")
            .header("Accept", "application/json")
            .header("User-Agent", userAgent())
            .header("X-Device-Secret", deviceSecret)
            .get()
            .build()
        return json.decodeFromString(execute(request))
    }

    suspend fun getMe(): MeResponse {
        return json.decodeFromString(execute(authorizedRequest("/api/tv/me").get().build()))
    }

    suspend fun getCatalog(force: Boolean = false): CatalogResponse {
        val path = if (force) "/api/tv/catalog?force=1" else "/api/tv/catalog"
        return json.decodeFromString(execute(authorizedRequest(path).get().build()))
    }

    suspend fun getWorkerConnection(workerId: String, refresh: Boolean = false): WorkerConnection {
        val suffix = if (refresh) "?refresh=1" else ""
        val path = "/api/tv/workers/${Uri.encode(workerId)}/connection$suffix"
        return json.decodeFromString(execute(authorizedRequest(path).get().build()))
    }

    suspend fun deleteMe() {
        execute(authorizedRequest("/api/tv/me").delete().build())
    }

    private fun authorizedRequest(path: String): Request.Builder {
        val builder = Request.Builder()
            .url("${baseUrl()}$path")
            .header("Accept", "application/json")
            .header("User-Agent", userAgent())

        tokenStore.getToken()?.takeIf { it.isNotBlank() }?.let { token ->
            builder.header("Authorization", "Bearer $token")
        }
        return builder
    }

    private fun baseUrl(): String {
        val url = settings.serverUrl()
        if (url.isBlank()) throw ApiException(0, "No StreamLift server is configured.")
        return url
    }

    private fun userAgent(): String = "StreamLiftTV/${BuildConfig.VERSION_NAME}"

    private suspend fun execute(request: Request): String = withContext(Dispatchers.IO) {
        client.newCall(request).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                val message = runCatching {
                    val error = json.parseToJsonElement(body).jsonObject
                    (error["message"] ?: error["error"])?.jsonPrimitive?.contentOrNull
                }.getOrNull()
                throw ApiException(response.code, message ?: "Request failed (${response.code})")
            }
            body
        }
    }

    companion object {
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(35, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            .build()
    }
}
