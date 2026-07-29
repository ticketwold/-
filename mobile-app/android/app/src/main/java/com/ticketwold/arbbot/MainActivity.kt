package com.ticketwold.arbbot

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment
import androidx.viewpager2.adapter.FragmentStateAdapter
import androidx.viewpager2.widget.ViewPager2
import com.google.android.material.bottomnavigation.BottomNavigationView
import org.json.JSONObject
import android.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class MainActivity : AppCompatActivity() {
    private lateinit var viewPager: ViewPager2
    private lateinit var bottomNav: BottomNavigationView
  private val fragments = mutableMapOf<String, SiteFragment>()
    private val readySites = ConcurrentHashMap.newKeySet<String>()
    private val pendingCallbacks = ConcurrentHashMap<String, (String) -> Unit>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        viewPager = findViewById(R.id.viewPager)
        bottomNav = findViewById(R.id.bottomNav)

        val adapter = MainPagerAdapter(this)
        viewPager.adapter = adapter
        viewPager.isUserInputEnabled = false
        viewPager.offscreenPageLimit = 3

        bottomNav.setOnItemSelectedListener { item ->
            when (item.itemId) {
                R.id.nav_control -> viewPager.setCurrentItem(0, false)
                R.id.nav_bti -> viewPager.setCurrentItem(1, false)
                R.id.nav_poly -> viewPager.setCurrentItem(2, false)
            }
            true
        }
    }

    fun registerFragment(site: String, fragment: SiteFragment) {
        fragments[site] = fragment
    }

    fun markReady(site: String, ready: Boolean) {
        if (ready) readySites.add(site) else readySites.remove(site)
    }

    fun isSiteReady(site: String): Boolean = readySites.contains(site)

    fun showSite(site: String) {
        runOnUiThread {
            when (site) {
                "bti" -> {
                    bottomNav.selectedItemId = R.id.nav_bti
                    viewPager.setCurrentItem(1, false)
                }
                "poly" -> {
                    bottomNav.selectedItemId = R.id.nav_poly
                    viewPager.setCurrentItem(2, false)
                }
                else -> {
                    bottomNav.selectedItemId = R.id.nav_control
                    viewPager.setCurrentItem(0, false)
                }
            }
        }
    }

    fun sendMessage(site: String, json: String): String {
        val fragment = fragments[site] ?: return JSONObject(mapOf("success" to false, "reason" to "WebView 없음")).toString()
        val msg = JSONObject(json)
        val id = msg.optString("_id", "")
        val latch = CountDownLatch(1)
        val resultRef = AtomicReference("{}")

        pendingCallbacks[id] = { res ->
            resultRef.set(res)
            latch.countDown()
        }

        val b64 = Base64.encodeToString(json.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
        fragment.evaluateJs("window.__mobileHandleMessage && window.__mobileHandleMessage(JSON.parse(atob('$b64')));")

        latch.await(12, TimeUnit.SECONDS)
        pendingCallbacks.remove(id)
        return resultRef.get()
    }

    fun evalScript(site: String, world: String, code: String): String {
        val fragment = fragments[site] ?: return "null"
        val latch = CountDownLatch(1)
        val resultRef = AtomicReference("null")
        val wrapped = "(function(){try{var r=$code;return typeof r==='string'?r:JSON.stringify(r);}catch(e){return JSON.stringify({success:false,reason:e.message});}})()"
        fragment.evaluateJs(wrapped) { value ->
            resultRef.set(if (value == "null" || value.isNullOrBlank()) "null" else value.trim('"').replace("\\\"", "\""))
            latch.countDown()
        }
        latch.await(8, TimeUnit.SECONDS)
        return resultRef.get()
    }

    fun resolveCallback(id: String, json: String) {
        pendingCallbacks.remove(id)?.invoke(json)
    }

    inner class MobileHostBridge {
        @JavascriptInterface
        fun sendMessage(site: String, json: String): String {
            return this@MainActivity.sendMessage(site, json)
        }

        @JavascriptInterface
        fun evalScript(site: String, world: String, code: String): String {
            return this@MainActivity.evalScript(site, world, code)
        }

        @JavascriptInterface
        fun showSite(site: String) {
            this@MainActivity.showSite(site)
        }

        @JavascriptInterface
        fun isSiteReady(site: String): Boolean {
            return this@MainActivity.isSiteReady(site)
        }

        @JavascriptInterface
        fun resolveCallback(id: String, json: String) {
            this@MainActivity.resolveCallback(id, json)
        }

        @JavascriptInterface
        fun onContentEvent(json: String) {
            val control = fragments["control"] ?: return
            val escaped = json.replace("\\", "\\\\").replace("'", "\\'")
            control.evaluateJs("window.MobileHost && window.MobileHost.onContentEvent && window.MobileHost.onContentEvent('$escaped');")
        }
    }

    inner class MainPagerAdapter(activity: AppCompatActivity) : FragmentStateAdapter(activity) {
        override fun getItemCount(): Int = 3

        override fun createFragment(position: Int): Fragment {
            return when (position) {
                1 -> SiteFragment.newInstance("bti", "https://www.x10x10s.com/sports/?gamecode=19")
                2 -> SiteFragment.newInstance("poly", "https://polymarket.com/sports/live")
                else -> SiteFragment.newInstance("control", "file:///android_asset/index.html")
            }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
class SiteFragment : Fragment(R.layout.fragment_site) {
    private var siteKey: String = "control"
    private var startUrl: String = ""
    private lateinit var webView: WebView
    private var injected = false

    override fun onViewCreated(view: android.view.View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        siteKey = arguments?.getString(ARG_SITE) ?: "control"
        startUrl = arguments?.getString(ARG_URL) ?: "file:///android_asset/index.html"
        webView = view.findViewById(R.id.webView)

        val activity = requireActivity() as MainActivity
        activity.registerFragment(siteKey, this)

        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.javaScriptCanOpenWindowsAutomatically = true
        settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        settings.userAgentString = settings.userAgentString + " ArbBotMobile/1.0"

        if (siteKey == "control") {
            webView.addJavascriptInterface(activity.MobileHostBridge(), "MobileHost")
        }

        webView.webChromeClient = WebChromeClient()
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = false

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                if (siteKey == "control") {
                    activity.markReady("control", true)
                    return
                }
                injectScripts()
                activity.markReady(siteKey, true)
            }
        }

        webView.loadUrl(startUrl)
    }

    fun evaluateJs(script: String, callback: ((String?) -> Unit)? = null) {
        webView.post {
            webView.evaluateJavascript(script) { value -> callback?.invoke(value) }
        }
    }

    private fun injectScripts() {
        if (injected || siteKey == "control") return
        injected = true
        val assets = requireContext().assets
        val shim = assets.open("inject/mobile_shim.js").bufferedReader().use { it.readText() }
        evaluateJs(shim)

        when (siteKey) {
            "bti" -> {
                val script = assets.open("inject/bti_content.js").bufferedReader().use { it.readText() }
                evaluateJs(script)
            }
            "poly" -> {
                val content = assets.open("inject/polymarket_content.js").bufferedReader().use { it.readText() }
                val main = assets.open("inject/polymarket_bet_main.js").bufferedReader().use { it.readText() }
                val mobile = assets.open("inject/poly_mobile.js").bufferedReader().use { it.readText() }
                evaluateJs(content)
                evaluateJs(main)
                evaluateJs(mobile)
            }
        }
    }

    companion object {
        private const val ARG_SITE = "site"
        private const val ARG_URL = "url"

        fun newInstance(site: String, url: String): SiteFragment {
            val fragment = SiteFragment()
            fragment.arguments = Bundle().apply {
                putString(ARG_SITE, site)
                putString(ARG_URL, url)
            }
            return fragment
        }
    }
}
