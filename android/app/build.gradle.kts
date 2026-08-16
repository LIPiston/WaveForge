plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// versionCode 与 versionName 统一推导：0.2.0 → 200（发布脚本使用同一规则，避免漂移）。
fun versionCodeOf(version: String): Int {
    val parts = version.split('.').map { it.toIntOrNull() ?: 0 }
    val major = parts.getOrElse(0) { 0 }
    val minor = parts.getOrElse(1) { 0 }
    val patch = parts.getOrElse(2) { 0 }
    return major * 10000 + minor * 100 + patch
}

val appVersionName = "0.2.0"

android {
    namespace = "com.waveforge.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.waveforge.android"
        // Android TV 设备普遍为 Android 9+（API 28），minSdk 24 已足够宽松。
        minSdk = 24
        targetSdk = 35
        versionName = appVersionName
        versionCode = versionCodeOf(appVersionName)

        externalNativeBuild {
            cmake {
                cppFlags("")
                // libnode.so 使用 libC++ STL 构建，必须使用 c++_shared 链接。
                arguments("-DANDROID_STL=c++_shared")
            }
        }

        ndk {
            // 现代 Android TV（2019 年后）几乎全是 64 位，默认只出 arm64 一个 ABI，
            // APK 体积减半。若需要支持老式 32 位盒子，把 "armeabi-v7a" 加回列表。
            abiFilters += listOf("arm64-v8a")
        }
    }

    externalNativeBuild {
        cmake {
            path = file("CMakeLists.txt")
            version = "3.22.1"
        }
    }

    sourceSets {
        getByName("main") {
            // 预编译的 libnode.so 按 ABI 放在 app/libnode/bin/<abi>/ 下。
            jniLibs.srcDirs("libnode/bin/")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    ndkVersion = "27.0.12077973"
}

dependencies {
    // FileProvider（APK 安装用，Android 7+ 不允许 file:// 分享安装包）
    implementation("androidx.core:core-ktx:1.13.1")
}
