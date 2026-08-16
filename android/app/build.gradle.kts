plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.waveforge.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.waveforge.android"
        // Android TV 设备普遍为 Android 9+（API 28），minSdk 24 已足够宽松。
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        externalNativeBuild {
            cmake {
                cppFlags("")
                // libnode.so 使用 libC++ STL 构建，必须使用 c++_shared 链接。
                arguments("-DANDROID_STL=c++_shared")
            }
        }

        ndk {
            // nodejs-mobile v18 只发布这三种 ABI（无 x86）。
            abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64")
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
