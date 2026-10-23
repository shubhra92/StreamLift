package io.streamlift.tv.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Stores the TV bearer token and pairing device secret encrypted with an
 * Android Keystore AES/GCM key. The raw token never touches disk.
 */
class TokenStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val keyStore: KeyStore by lazy {
        KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    }

    fun getToken(): String? = readSecure(KEY_TOKEN)

    fun saveToken(token: String) {
        writeSecure(KEY_TOKEN, token)
    }

    fun clearToken() {
        prefs.edit().remove(KEY_TOKEN).apply()
    }

    /**
     * The device secret is generated on the TV and never displayed. It is only
     * used while polling before the device receives its bearer token.
     */
    fun getOrCreateDeviceSecret(): String {
        val existing = readSecure(KEY_DEVICE_SECRET)
        if (!existing.isNullOrBlank()) return existing

        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        val secret = bytes.joinToString("") { byte ->
            (byte.toInt() and 0xff).toString(16).padStart(2, '0')
        }
        writeSecure(KEY_DEVICE_SECRET, secret)
        return secret
    }

    fun clearAll() {
        prefs.edit().clear().apply()
    }

    private fun readSecure(name: String): String? {
        val stored = prefs.getString(name, null) ?: return null
        return try {
            val payload = Base64.decode(stored, Base64.NO_WRAP)
            if (payload.size <= GCM_IV_BYTES) return null

            val iv = payload.copyOfRange(0, GCM_IV_BYTES)
            val ciphertext = payload.copyOfRange(GCM_IV_BYTES, payload.size)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
            String(cipher.doFinal(ciphertext), Charsets.UTF_8)
        } catch (error: Exception) {
            Log.w(TAG, "Could not decrypt $name", error)
            prefs.edit().remove(name).apply()
            null
        }
    }

    private fun writeSecure(name: String, value: String) {
        try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            val iv = cipher.iv
            val ciphertext = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
            val payload = iv + ciphertext
            prefs.edit()
                .putString(name, Base64.encodeToString(payload, Base64.NO_WRAP))
                .apply()
        } catch (error: Exception) {
            Log.e(TAG, "Could not encrypt $name", error)
        }
    }

    private fun getOrCreateKey(): SecretKey {
        val existing = keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry
        if (existing != null) return existing.secretKey

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    companion object {
        private const val TAG = "StreamLiftTokenStore"
        private const val PREFS_NAME = "streamlift_tv_auth"
        private const val KEY_TOKEN = "device_token"
        private const val KEY_DEVICE_SECRET = "device_secret"
        private const val KEY_ALIAS = "streamlift_tv_token_key"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_IV_BYTES = 12
    }
}
