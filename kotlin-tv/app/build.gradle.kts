import java.util.Properties
import org.gradle.api.GradleException

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) {
        file.inputStream().use { load(it) }
    }
}

// Version defaults are used for local builds. Release builds override both
// properties from the git tag (e.g. tv-v0.1.0 -> 0.1.0 / 100).
val appVersionName: String = (findProperty("appVersionName") as String?)
    ?.trim()
    ?.takeIf { it.isNotEmpty() }
    ?: "0.1.0"

val appVersionCode: Int = (findProperty("appVersionCode") as String?)
    ?.trim()
    ?.toIntOrNull()
    ?: 1

val releaseKeystoreFile = System.getenv("TV_KEYSTORE_PATH")
    ?.trim()
    ?.takeIf { it.isNotEmpty() }
    ?.let { file(it) }
    ?.takeIf { it.isFile }

if (findProperty("requireReleaseSigning") == "true" && releaseKeystoreFile == null) {
    throw GradleException(
        "requireReleaseSigning=true but TV_KEYSTORE_PATH is not set or the file does not exist.",
    )
}

val defaultServerUrl: String = (
    localProperties.getProperty("streamlift.server.url")
        ?: rootProject.findProperty("streamlift.server.url") as String?
        ?: System.getenv("STREAMLIFT_SERVER_URL")
        ?: ""
    ).trim()

android {
    namespace = "io.streamlift.tv"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.streamlift.tv"
        minSdk = 23
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName

        buildConfigField(
            "String",
            "DEFAULT_SERVER_URL",
            "\"${defaultServerUrl.replace("\\", "\\\\").replace("\"", "\\\"")}\"",
        )
        manifestPlaceholders["usesCleartextTraffic"] = "false"
    }

    signingConfigs {
        // Only configured when the CI workflow decodes the release keystore.
        // Local builds stay unsigned and can still use assembleRelease.
        if (releaseKeystoreFile != null) {
            create("release") {
                storeFile = releaseKeystoreFile
                storePassword = System.getenv("TV_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("TV_KEY_ALIAS")
                keyPassword = System.getenv("TV_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            // Debug builds are for local/self-hosted testing, where the web app
            // is often reachable over plain HTTP on the LAN.
            manifestPlaceholders["usesCleartextTraffic"] = "true"
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            manifestPlaceholders["usesCleartextTraffic"] = "false"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.androidx.tv.foundation)

    implementation(libs.androidx.media3.exoplayer)
    implementation(libs.androidx.media3.exoplayer.hls)
    implementation(libs.androidx.media3.ui)

    implementation(libs.coil.compose)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    debugImplementation(libs.androidx.compose.ui.tooling)
}
