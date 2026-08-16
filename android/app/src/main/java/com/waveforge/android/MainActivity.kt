package com.waveforge.android

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ProgressBar
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/**
 * WaveForge Android 壳。
 *
 * 启动顺序：
 *  1. 把 assets/nodejs-project 解压到 filesDir（版本变化时重新解压）。
 *  2. 后台线程通过 JNI 调用 node::Start 启动内置 Node（android-server 打包产物 main.cjs，
 *     它在 localhost:3001 同时提供 API 与前端静态资源）。
 *  3. 轮询 http://localhost:3001/health 就绪后，WebView 加载 http://localhost:3001/。
 *
 * 说明：nodejs-mobile 每次进程只允许一个 Node 实例且不支持重启，因此 Node 一旦启动即常驻。
 */
class MainActivity : Activity() {

    companion object {
        private const val NODE_ASSETS_DIR = "nodejs-project"
        private const val PREF_TAG_KEY = "node_assets_version"
        private const val ASSETS_VERSION = 2
        private const val SERVER_URL = "http://localhost:3001/"
        private const val HEALTH_URL = "http://localhost:3001/health"
    }

    private lateinit var webView: WebView
    private val nodeStarted = AtomicBoolean(false)

    init {
        System.loadLibrary("native-lib")
        System.loadLibrary("node")
    }

    private external fun startNodeWithArguments(args: Array<String>): Int

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // TV 播放场景保持屏幕常亮。
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#0a0f14"))
        }

        val progress = ProgressBar(this, null, android.R.attr.progressBarStyleLarge).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { gravity = Gravity.CENTER }
        }
        root.addView(progress)

        webView = WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            visibility = View.GONE
            setBackgroundColor(Color.parseColor("#0a0f14"))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            // 页面源是 http://localhost:3001，加载 http 的网易云 CDN 音频不属于混合内容；
            // 这里仍放开兜底，避免个别 https 页面加载 http 资源时被拦。
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            webViewClient = WebViewClient()
            webChromeClient = WebChromeClient()
            // 供前端"检查更新"按钮触发原生更新器（TV 上由原生弹窗下载安装）
            addJavascriptInterface(object {
                @android.webkit.JavascriptInterface
                fun checkForUpdates() {
                    UpdateChecker.check(this@MainActivity, force = true)
                }
            }, "WaveForgeNative")
        }
        root.addView(webView)
        setContentView(root)

        if (nodeStarted.compareAndSet(false, true)) {
            Thread {
                ensureNodeProject()
                val mainJs = File(filesDir, "$NODE_ASSETS_DIR/main.cjs").absolutePath
                startNodeWithArguments(arrayOf("node", mainJs))
            }.start()
        }

        waitForServerAndLoad()
    }

    /** 把 assets/nodejs-project 解压到 filesDir；版本标记变化才重解。 */
    private fun ensureNodeProject() {
        val dest = File(filesDir, NODE_ASSETS_DIR)
        val prefs = getSharedPreferences("waveforge", Context.MODE_PRIVATE)
        if (dest.exists() && prefs.getInt(PREF_TAG_KEY, -1) == ASSETS_VERSION) return
        dest.deleteRecursively()
        copyAssetDir(NODE_ASSETS_DIR, dest)
        prefs.edit().putInt(PREF_TAG_KEY, ASSETS_VERSION).apply()
    }

    private fun copyAssetDir(path: String, dest: File) {
        assets.list(path)?.forEach { name ->
            val childPath = "$path/$name"
            val out = File(dest, name)
            if (assets.list(childPath)?.isNotEmpty() == true) {
                out.mkdirs()
                copyAssetDir(childPath, out)
            } else {
                assets.open(childPath).use { input ->
                    out.outputStream().use { output -> input.copyTo(output) }
                }
            }
        }
    }

    /** 轮询 Node 服务直到 /health 就绪，然后加载应用。 */
    private fun waitForServerAndLoad() {
        Thread {
            var ready = false
            var attempts = 0
            while (!ready && attempts < 240) { // 最多约 60 秒
                attempts++
                ready = isServerUp()
                if (!ready) Thread.sleep(250)
            }
            runOnUiThread {
                webView.visibility = View.VISIBLE
                webView.requestFocus()
                webView.loadUrl(SERVER_URL)
                // 应用内更新检查（后台拉清单，有新版弹窗，不影响启动）
                UpdateChecker.check(this)
            }
        }.start()
    }

    private fun isServerUp(): Boolean = try {
        val conn = URL(HEALTH_URL).openConnection() as HttpURLConnection
        conn.connectTimeout = 1500
        conn.readTimeout = 1500
        conn.requestMethod = "GET"
        val code = conn.responseCode
        conn.disconnect()
        code in 200..299
    } catch (e: Exception) {
        false
    }

    // ---------- 遥控器键位 ----------

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        // 媒体键通常不会作为 DOM 事件到达 WebView，这里显式转发给页面（页面侧有对应 keydown 处理）。
        if (webView.visibility == View.VISIBLE) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_MEDIA_PLAY,
                KeyEvent.KEYCODE_MEDIA_PAUSE,
                KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
                KeyEvent.KEYCODE_MEDIA_STOP,
                KeyEvent.KEYCODE_MEDIA_NEXT,
                KeyEvent.KEYCODE_MEDIA_PREVIOUS -> {
                    if (event.action == KeyEvent.ACTION_DOWN) {
                        forwardKeyToDom(event.keyCode)
                    }
                    return true
                }
            }
        }
        return super.dispatchKeyEvent(event)
    }

    private fun forwardKeyToDom(keyCode: Int) {
        webView.post {
            webView.evaluateJavascript(
                "window.dispatchEvent(new KeyboardEvent('keydown', {keyCode: $keyCode, which: $keyCode, bubbles: true, cancelable: true}));" +
                    "window.dispatchEvent(new KeyboardEvent('keyup', {keyCode: $keyCode, which: $keyCode, bubbles: true, cancelable: true}));",
                null
            )
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // BACK：优先返回页面历史，否则退到桌面。
        if (webView.visibility == View.VISIBLE && webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        webView.destroy()
    }
}
