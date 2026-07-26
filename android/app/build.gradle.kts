plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

fun escapedBuildString(value: String): String = "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""

val fcmAppId = providers.gradleProperty("codexFcmAppId").orElse("").get()
val fcmApiKey = providers.gradleProperty("codexFcmApiKey").orElse("").get()
val fcmProjectId = providers.gradleProperty("codexFcmProjectId").orElse("").get()
val fcmSenderId = providers.gradleProperty("codexFcmSenderId").orElse("").get()

android {
    namespace = "com.codexmonitor.mobile"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.codexmonitor.mobile"
        minSdk = 26
        targetSdk = 36
        versionCode = 50
        versionName = "0.11.22"
        buildConfigField("String", "FCM_APP_ID", escapedBuildString(fcmAppId))
        buildConfigField("String", "FCM_API_KEY", escapedBuildString(fcmApiKey))
        buildConfigField("String", "FCM_PROJECT_ID", escapedBuildString(fcmProjectId))
        buildConfigField("String", "FCM_SENDER_ID", escapedBuildString(fcmSenderId))
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Existing sideloaded builds use this certificate; keep upgrades compatible.
            signingConfig = signingConfigs.getByName("debug")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.06.01"))
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.1")
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.fragment:fragment-ktx:1.8.8")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation(platform("com.google.firebase:firebase-bom:33.16.0"))
    implementation("com.google.firebase:firebase-messaging")
    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("junit:junit:4.13.2")
}
