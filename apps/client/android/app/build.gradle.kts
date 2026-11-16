plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }

// One release version: apps/client/package.json (kept in step by
// scripts/distribution/set-version.mjs). versionCode = major*1e6 + minor*1e3 + patch.
val clientManifest = groovy.json.JsonSlurper().parse(rootProject.file("../package.json")) as Map<*, *>
val releaseVersion = clientManifest["version"] as String
val releaseParts = Regex("^(\\d+)\\.(\\d+)\\.(\\d+)(?:-[0-9A-Za-z.-]+)?$").matchEntire(releaseVersion)
    ?.groupValues?.drop(1)?.map { it.toInt() }
    ?: throw GradleException("Invalid client version $releaseVersion")
val releaseCode = releaseParts[0] * 1_000_000 + releaseParts[1] * 1_000 + releaseParts[2]

// Release signing comes only from the environment (CI secrets or a local shell).
// Every update must be signed with this same key; Android refuses anything else.
val releaseKeystore = System.getenv("STREAMERAI_ANDROID_KEYSTORE")?.takeIf { it.isNotBlank() }

android {
    namespace = "ai.streamer.client"
    compileSdk = 36
    defaultConfig {
        applicationId = "ai.streamer.client"
        minSdk = 26
        targetSdk = 36
        versionCode = releaseCode
        versionName = releaseVersion
        buildConfigField("String", "UPDATE_MANIFEST_URL", "\"https://github.com/sgtkingo/StreamerAI/releases/latest/download/stable.json\"")
    }
    buildFeatures { buildConfig = true }
    signingConfigs {
        if (releaseKeystore != null) create("release") {
            storeFile = file(releaseKeystore)
            storePassword = System.getenv("STREAMERAI_ANDROID_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("STREAMERAI_ANDROID_KEY_ALIAS")
            keyPassword = System.getenv("STREAMERAI_ANDROID_KEY_PASSWORD")
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            if (releaseKeystore != null) signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
}
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
dependencies { testImplementation("junit:junit:4.13.2") }
