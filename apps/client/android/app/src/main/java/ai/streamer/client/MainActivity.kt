package ai.streamer.client

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.os.Build
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.util.UUID
import java.util.concurrent.Executors

@Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
class MainActivity : Activity() {
    private val worker = Executors.newSingleThreadExecutor()
    private val preferences by lazy { getSharedPreferences("streamerai-client", MODE_PRIVATE) }
    private lateinit var clientId: String
    private var selected: HomeServer? = null
    private var web: WebView? = null
    private var remoteVisible = false
    private var fullscreen: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
    private lateinit var root: FrameLayout
    private lateinit var chooser: ScrollView
    private lateinit var serverList: LinearLayout
    private lateinit var status: TextView
    private lateinit var address: EditText
    private lateinit var search: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        clientId = preferences.getString("clientId", null) ?: UUID.randomUUID().toString().also { preferences.edit().putString("clientId", it).apply() }
        selected = preferences.getString("selected", null)?.let { try { HomeServer.saved(it) } catch (_: Exception) { null } }
        root = FrameLayout(this).apply { setBackgroundColor(Color.rgb(16, 16, 17)) }
        root.setOnApplyWindowInsetsListener { view, insets -> view.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom); insets }
        setContentView(root)
        if (Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT) { navigateBack() }
        buildChooser()
        val link = intent?.dataString
        if (link?.startsWith("streamerai://") == true) connect(link)
        else selected?.let { connect(it.url, it.serverId) } ?: discover()
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); intent.dataString?.takeIf { it.startsWith("streamerai://") }?.let { connect(it) } }
    private fun px(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun text(value: String, size: Float = 15f) = TextView(this).apply { text = value; textSize = size; setTextColor(Color.rgb(225, 220, 216)); setPadding(0, px(6), 0, px(10)) }
    private fun button(value: String, action: () -> Unit) = Button(this).apply { text = value; isAllCaps = false; isFocusable = true; minHeight = px(48); setOnClickListener { action() }; setOnFocusChangeListener { view, focused -> view.alpha = if (focused) 1f else 0.85f } }
    private fun buildChooser() {
        chooser = ScrollView(this).apply { isFillViewport = true }
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(px(28), px(28), px(28), px(28)) }
        body.addView(text("STREAMER AI", 18f).apply { setTextColor(Color.rgb(255, 41, 52)) })
        body.addView(text("Connect to your home server", 28f))
        body.addView(text("Choose your server. Your profiles and playback stay on that server."))
        status = text("Looking for your server…")
        body.addView(status)
        search = button("Search again") { discover() }; body.addView(search)
        serverList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; body.addView(serverList)
        body.addView(text("Server address or QR connection link", 17f))
        address = EditText(this).apply { setSingleLine(true); hint = "https://streamerai.local:8443"; inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI; setTextColor(Color.WHITE); setHintTextColor(Color.GRAY); contentDescription = "Server URL or QR connection link" }
        body.addView(address)
        body.addView(button("Connect") { connect(address.text.toString().trim()) })
        body.addView(text("If network discovery is blocked by a router, VPN or Docker, enter the address shown by the server owner. A QR connection link can also open this app from your camera."))
        selected?.let { saved -> body.addView(text("Saved server: ${saved.name}\n${saved.url}")); body.addView(button("Open saved server") { connect(saved.url, saved.serverId) }); body.addView(button("Forget server and pairing") { forget() }) }
        body.addView(text("Client ID: $clientId", 12f))
        chooser.addView(body); root.addView(chooser, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        search.requestFocus()
    }
    private fun discover() {
        search.isEnabled = false; status.text = "Looking for your server…"; serverList.removeAllViews()
        worker.execute {
            try { val found = Discovery.find(this); runOnUiThread { if (isDestroyed) return@runOnUiThread; status.text = if (found.isEmpty()) "No server found. Enter its address below." else "Choose your home server."; for (server in found) serverList.addView(button("${server.name}\n${server.url}") { connect(server.url, server.serverId) }) } }
            catch (_: Exception) { runOnUiThread { status.text = "Discovery is unavailable. Enter the server address below." } }
            finally { runOnUiThread { if (!isDestroyed) search.isEnabled = true } }
        }
    }
    private fun connect(value: String, expected: String? = null) {
        status.text = "Checking server identity…"
        worker.execute {
            try {
                val input = ServerPolicy.connection(value)
                val server = Discovery.verify(input.copy(serverId = expected ?: input.serverId))
                preferences.edit().putString("selected", server.json()).apply(); selected = server
                runOnUiThread { if (!isDestroyed) openServer(server) }
            } catch (error: Exception) { runOnUiThread { if (!isDestroyed) { showChooser(); status.text = error.message ?: "The server could not be reached." } } }
        }
    }
    @SuppressLint("SetJavaScriptEnabled")
    private fun openServer(server: HomeServer) {
        web?.let { root.removeView(it); it.destroy() }
        val browser = WebView(this); web = browser
        browser.settings.apply {
            javaScriptEnabled = true; domStorageEnabled = true; allowFileAccess = false; allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW; mediaPlaybackRequiresUserGesture = true
            safeBrowsingEnabled = true; setSupportMultipleWindows(true); javaScriptCanOpenWindowsAutomatically = false
            setGeolocationEnabled(false)
        }
        CookieManager.getInstance().setAcceptCookie(true); CookieManager.getInstance().setAcceptThirdPartyCookies(browser, false)
        browser.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (ServerPolicy.sameOrigin(request.url.toString(), server.url)) return false
                if (request.isForMainFrame && request.hasGesture()) openExternal(request.url.toString())
                return request.isForMainFrame
            }
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) { handler.cancel(); showChooser(); status.text = "The server certificate is not trusted. Install the server's CA certificate in Android settings before connecting." }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) { if (request.isForMainFrame) { showChooser(); status.text = "The home server is unavailable. Check its address and network." } }
            override fun onPageFinished(view: WebView, url: String) { CookieManager.getInstance().flush() }
        }
        browser.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: android.webkit.PermissionRequest) { request.deny() }
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (fullscreen != null) { callback.onCustomViewHidden(); return }
                fullscreen = view; fullscreenCallback = callback; browser.visibility = View.GONE
                root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            }
            override fun onHideCustomView() { hideFullscreen() }
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message): Boolean {
                if (!isUserGesture) return false
                val temporary = WebView(this@MainActivity)
                temporary.webViewClient = object : WebViewClient() { override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean { openExternal(request.url.toString()); temporary.destroy(); return true } }
                (resultMsg.obj as WebView.WebViewTransport).webView = temporary; resultMsg.sendToTarget(); return true
            }
        }
        browser.isFocusable = true; browser.isFocusableInTouchMode = true
        root.addView(browser, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        chooser.visibility = View.GONE; remoteVisible = true; browser.requestFocus()
        browser.loadUrl(server.url, mapOf("X-Streamer-Client-Id" to clientId))
    }
    private fun openExternal(value: String) { if (ServerPolicy.safeExternal(value)) try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(value)).addCategory(Intent.CATEGORY_BROWSABLE)) } catch (_: Exception) { status.text = "No browser is available to open this link." } }
    private fun showChooser() { hideFullscreen(); web?.visibility = View.GONE; root.removeView(chooser); buildChooser(); remoteVisible = false; search.requestFocus() }
    private fun hideFullscreen() { fullscreen?.let { root.removeView(it) }; fullscreen = null; fullscreenCallback?.onCustomViewHidden(); fullscreenCallback = null; web?.visibility = if (remoteVisible) View.VISIBLE else View.GONE; window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE }
    private fun forget() { preferences.edit().remove("selected").apply(); selected = null; CookieManager.getInstance().removeAllCookies { CookieManager.getInstance().flush() }; web?.destroy(); web = null; root.removeAllViews(); buildChooser(); discover() }
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_MENU) { showChooser(); return true }
        if (keyCode == KeyEvent.KEYCODE_BACK) { navigateBack(); return true }
        return super.onKeyDown(keyCode, event)
    }
    private fun navigateBack() { if (fullscreen != null) hideFullscreen() else if (remoteVisible && web?.canGoBack() == true) web?.goBack() else if (remoteVisible) showChooser() else finish() }
    override fun onBackPressed() { navigateBack() }
    override fun onPause() { super.onPause(); CookieManager.getInstance().flush() }
    override fun onDestroy() { worker.shutdownNow(); web?.destroy(); super.onDestroy() }
}
