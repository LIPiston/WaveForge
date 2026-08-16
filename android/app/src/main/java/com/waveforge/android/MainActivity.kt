package com.waveforge.android

import android.annotation.SuppressLint
import android.app.Activity
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.StatFs
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
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
        private const val ASSETS_VERSION = 10
        private const val SERVER_URL = "http://localhost:3001/"
        private const val HEALTH_URL = "http://localhost:3001/health"
        // QQ 统一登录页（appid=716027609 为 QQ 音乐）：自带二维码，加载即出扫码登录，
        // 手机 QQ 扫后跳回 s_url（y.qq.com），音乐 cookie 随之写入，轮询即可捕获。
        // 比加载 y.qq.com 再模拟点击"登录"更可靠（电视无鼠标，无需任何网页操作）。
        private const val QQ_LOGIN_URL =
            "https://xui.ptlogin2.qq.com/cgi-bin/xlogin" +
            "?appid=716027609" +
            "&daid=16" +
            "&pt_no_auth=1" +
            "&s_url=https%3A%2F%2Fy.qq.com%2Fn%2Fryqq_v2%2Fprofile%2Flike%2Fsong"
    }

    private lateinit var webView: WebView
    private lateinit var rootView: FrameLayout
    private var qqLoginWebView: WebView? = null
    private var qqLoginPolling: Thread? = null
    private val nodeStarted = AtomicBoolean(false)
    // 焦点在滑块上时由 Web 层开启：音量键转发给页面做 +1/-1 调节，不再调系统音量
    @Volatile
    private var volumeKeyCapture = false

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

        rootView = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#0a0f14"))
        }

        val progress = ProgressBar(this, null, android.R.attr.progressBarStyleLarge).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { gravity = Gravity.CENTER }
        }
        rootView.addView(progress)

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

                // 应用内 QQ 扫码登录（电视上没有 Electron 登录窗口）
                @android.webkit.JavascriptInterface
                fun openQQLogin() {
                    openQQLoginWindow()
                }

                @android.webkit.JavascriptInterface
                fun closeQQLogin() {
                    closeQQLoginWindow()
                }

                // 打开外部链接（TV 无浏览器窗口，交给系统浏览器应用）
                @android.webkit.JavascriptInterface
                fun openExternal(url: String) {
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    } catch (_: Exception) {}
                }

                // 设备识别码（TV 端设置页显示）
                @android.webkit.JavascriptInterface
                fun getDeviceId(): String {
                    return android.provider.Settings.Secure.getString(
                        contentResolver,
                        android.provider.Settings.Secure.ANDROID_ID
                    ) ?: "unknown"
                }

                // 滑块聚焦时开启音量键捕获（音量键改为调节滑块，而非系统音量）
                @android.webkit.JavascriptInterface
                fun setVolumeKeyCapture(v: Boolean) {
                    volumeKeyCapture = v
                }

                // 设备详情（配置检查面板用）：内存/存储/CPU/型号
                @android.webkit.JavascriptInterface
                fun getDeviceInfo(): String {
                    return try {
                        val am = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
                        val mi = ActivityManager.MemoryInfo()
                        am.getMemoryInfo(mi)
                        val stat = StatFs(Environment.getDataDirectory().path)
                        org.json.JSONObject()
                            .put("model", Build.MODEL)
                            .put("manufacturer", Build.MANUFACTURER)
                            .put("apiLevel", Build.VERSION.SDK_INT)
                            .put("totalMem", mi.totalMem)
                            .put("availMem", mi.availMem)
                            .put("heapMax", Runtime.getRuntime().maxMemory())
                            .put("storageTotal", stat.totalBytes)
                            .put("storageFree", stat.availableBytes)
                            .put("cpuCores", Runtime.getRuntime().availableProcessors())
                            .toString()
                    } catch (_: Exception) {
                        "{}"
                    }
                }
            }, "WaveForgeNative")
        }
        rootView.addView(webView)
        setContentView(rootView)

        if (nodeStarted.compareAndSet(false, true)) {
            Thread {
                ensureNodeProject()
                val mainJs = File(filesDir, "$NODE_ASSETS_DIR/main.cjs").absolutePath
                startNodeWithArguments(arrayOf("node", mainJs))
            }.start()
        }

        // 更新生效标记：安装前写入 Web 端 localStorage，供前端"版本更新成功"弹窗使用
        UpdateChecker.beforeInstallHook = { version, notes ->
            webView.post {
                val payload = org.json.JSONObject().put("version", version).put("notes", notes).toString()
                webView.evaluateJavascript(
                    "localStorage.setItem('waveforge:update-applied', JSON.stringify($payload))", null)
            }
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

    // ---------- 应用内 QQ 扫码登录（电视上没有 Electron 登录窗口） ----------

    private fun openQQLoginWindow() {
        if (qqLoginWebView != null) return // 已打开
        runOnUiThread {
            val overlay = WebView(this).apply {
                layoutParams = FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                // 登录弹窗可能用 window.open 打开，允许并重定向回当前覆盖层
                settings.javaScriptCanOpenWindowsAutomatically = true
                settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                setBackgroundColor(Color.parseColor("#0a0f14"))
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                        val url = request?.url?.toString() ?: return false
                        if (!isQQDomain(url)) {
                            // 登录流程之外的站点交给系统浏览器，避免登录态外泄
                            try {
                                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                            } catch (_: Exception) {}
                            return true
                        }
                        return false
                    }

                    override fun onPageFinished(view: WebView?, url: String?) {
                        injectQQLoginHelper(view)
                    }
                }
                webChromeClient = object : WebChromeClient() {
                    // window.open 的新窗口重定向到当前覆盖层，避免 QQ 登录弹窗打不开
                    override fun onCreateWindow(
                        view: WebView?,
                        isDialog: Boolean,
                        isUserGesture: Boolean,
                        resultMsg: android.os.Message?
                    ): Boolean {
                        val transport = resultMsg?.obj as? WebView.WebViewTransport ?: return false
                        transport.webView = view
                        resultMsg.sendToTarget()
                        return true
                    }
                }
            }
            rootView.addView(overlay)
            qqLoginWebView = overlay
            overlay.loadUrl(QQ_LOGIN_URL)
            startQQCookiePolling()
        }
    }

    private fun closeQQLoginWindow() {
        qqLoginPolling?.interrupt()
        qqLoginPolling = null
        runOnUiThread {
            qqLoginWebView?.destroy()
            qqLoginWebView?.let { rootView.removeView(it) }
            qqLoginWebView = null
            // 通知 SPA 登录流程已结束（未取到 cookie 时用于复位 loading）
            webView.post {
                webView.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('qqLoginClosed', { detail: {} }))", null)
            }
        }
    }

    private fun isQQDomain(url: String): Boolean = try {
        val host = Uri.parse(url).host?.lowercase() ?: return false
        host == "qq.com" || host.endsWith(".qq.com")
    } catch (_: Exception) {
        false
    }

    private fun injectQQLoginHelper(view: WebView?) {
        view?.evaluateJavascript(
            """
            (function () {
              if (document.getElementById('wf-qq-login-bar')) return;

              // ---- 顶部提示条 + 关闭按钮 ----
              var bar = document.createElement('div');
              bar.id = 'wf-qq-login-bar';
              bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483000;background:rgba(8,12,20,0.94);color:#fff;font-size:15px;padding:14px 18px;display:flex;align-items:center;justify-content:space-between;gap:12px;font-family:sans-serif;';
              bar.innerHTML = '<span>请用手机 QQ 扫一扫电视上的二维码登录，完成后自动返回</span>' +
                '<button id="wf-qq-login-close" style="flex:none;background:rgba(255,255,255,0.16);color:#fff;border:none;border-radius:8px;padding:8px 18px;font-size:14px;">关闭</button>';
              document.body.appendChild(bar);
              document.getElementById('wf-qq-login-close').addEventListener('click', function () {
                try { window.WaveForgeNative.closeQQLogin(); } catch (e) {}
              });

              // ---- 自动打开登录弹窗（电视无鼠标，不能让用户去点"登录"） ----
              // ptlogin2 统一登录页自带二维码，无需自动点击（且避免误点"密码登录"）
              if (location.hostname.indexOf('ptlogin') !== -1) return;
              window.__wfAutoLoginTries = window.__wfAutoLoginTries || 0;

              function pickByText(texts) {
                var all = document.querySelectorAll('button, a, div, span, li, em, i');
                for (var i = 0; i < all.length; i++) {
                  var el = all[i];
                  if (el.children.length > 4) continue; // 跳过容器
                  var t = (el.textContent || '').trim();
                  if (!t || t.length > 6) continue;
                  for (var k = 0; k < texts.length; k++) {
                    if (t === texts[k] || t.indexOf(texts[k]) !== -1) return el;
                  }
                }
                return null;
              }

              function loginDialogOpened() {
                if (document.querySelector('iframe[src*="ptlogin"], iframe[src*="xui.ptlogin"], [id*="ptlogin"], [class*="ptlogin"]')) return true;
                var bodyText = (document.body ? document.body.innerText : '');
                return bodyText.indexOf('二维码') !== -1 || bodyText.indexOf('扫码') !== -1;
              }

              function tryOpenLogin() {
                if (loginDialogOpened() || window.__wfAutoLoginTries > 6) return;
                window.__wfAutoLoginTries++;
                // 1) 点"登录"
                var btn = pickByText(['登录', '登 录', '立即登录', '登录QQ']);
                if (btn) { btn.click(); }
                // 2) 等弹窗渲染后，若默认不是扫码 tab，点"扫码登录/二维码"
                setTimeout(function () {
                  if (loginDialogOpened()) return;
                  var qr = pickByText(['扫码登录', '二维码登录', '扫码', '二维码']);
                  if (qr) qr.click();
                }, 1800);
                // 3) 没弹出来就再试
                setTimeout(tryOpenLogin, 2500);
              }

              // 页面可能是 SPA，多等几轮让脚本渲染完成
              setTimeout(tryOpenLogin, 800);
              setTimeout(tryOpenLogin, 2500);
              setTimeout(tryOpenLogin, 5000);
            })();
            """.trimIndent(),
            null
        )
    }

    private fun startQQCookiePolling() {
        qqLoginPolling?.interrupt()
        qqLoginPolling = Thread {
            var attempts = 0
            while (!Thread.currentThread().isInterrupted && attempts < 300) { // 最多 10 分钟
                attempts++
                val cookie = CookieManager.getInstance().getCookie("https://y.qq.com/")
                if (cookie != null && isQQLoggedInCookie(cookie)) {
                    runOnUiThread {
                        val payload = org.json.JSONObject().put("cookie", cookie).toString()
                        webView.evaluateJavascript(
                            "window.dispatchEvent(new CustomEvent('qqLoginCookieCaptured', { detail: $payload }))",
                            null
                        )
                        closeQQLoginWindow()
                    }
                    return@Thread
                }
                try {
                    Thread.sleep(2000)
                } catch (_: InterruptedException) {
                    return@Thread
                }
            }
        }.apply { start() }
    }

    private fun isQQLoggedInCookie(cookie: String): Boolean {
        val hasUserId = cookie.contains("uin=") || cookie.contains("wxuin=")
        val hasMusicKey = cookie.contains("qm_keyst=") || cookie.contains("qqmusic_key=")
        return hasUserId && hasMusicKey
    }

    // ---------- 遥控器键位 ----------

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        // 滑块聚焦（Web 层已开启捕获）：音量键转发给页面做 +1/-1，不再调系统音量
        if (volumeKeyCapture && (event.keyCode == KeyEvent.KEYCODE_VOLUME_UP || event.keyCode == KeyEvent.KEYCODE_VOLUME_DOWN)) {
            if (event.action == KeyEvent.ACTION_DOWN) {
                forwardKeyToDom(event.keyCode)
            }
            return true
        }

        // BACK：QQ 登录覆盖层打开时优先关闭它
        if (event.keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_DOWN) {
            if (qqLoginWebView != null) {
                closeQQLoginWindow()
                return true
            }
        }

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
        // QQ 登录覆盖层打开时优先关闭
        if (qqLoginWebView != null) {
            closeQQLoginWindow()
            return
        }
        // BACK：优先返回页面历史，否则退到桌面。
        if (webView.visibility == View.VISIBLE && webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        qqLoginPolling?.interrupt()
        qqLoginWebView?.destroy()
        webView.destroy()
    }
}
