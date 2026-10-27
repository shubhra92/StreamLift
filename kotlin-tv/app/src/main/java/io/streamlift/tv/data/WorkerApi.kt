package io.streamlift.tv.data

import android.net.Uri
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** Direct worker calls. Media bytes never pass through the Next.js server. */
class WorkerApi(
    private val client: OkHttpClient = defaultClient(),
    private val json: Json = Json { ignoreUnknownKeys = true; isLenient = true },
) {
    suspend fun mediaTicket(
        baseUrl: String,
        sessionToken: String,
        downloadId: String,
        fileIndex: Int,
        caps: String,
        tunnelHeaders: Map<String, String> = emptyMap(),
    ): MediaTicket {
        val url = buildString {
            append(baseUrl.trimEnd('/'))
            append("/downloads/")
            append(Uri.encode(downloadId))
            append("/files/")
            append(fileIndex)
            append("/media-ticket?caps=")
            append(Uri.encode(caps))
        }

        val request = Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            .header("X-Session-Token", sessionToken)
            .apply { tunnelHeaders.forEach { (k, v) -> header(k, v) } }
            .header("User-Agent", "StreamLiftTV")
            .post(ByteArray(0).toRequestBody(null))
            .build()

        val body = execute(request)
        return json.decodeFromString(body)
    }

    private suspend fun execute(request: Request): String = withContext(Dispatchers.IO) {
        client.newCall(request).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                val message = runCatching {
                    val error = json.parseToJsonElement(body).jsonObject
                    (error["message"] ?: error["detail"] ?: error["error"])
                        ?.jsonPrimitive
                        ?.contentOrNull
                }.getOrNull()
                throw ApiException(response.code, message ?: "Worker request failed (${response.code})")
            }
            body
        }
    }

    companion object {
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(35, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            .build()
    }
}
