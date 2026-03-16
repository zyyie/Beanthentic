package com.beanthentic.app

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    @SuppressLint("SetJavaScriptEnabled")
    @Suppress("DEPRECATION")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val webView = WebView(this).apply {
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = true
                allowContentAccess = true
                mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                cacheMode = WebSettings.LOAD_DEFAULT
                // Let fetch() load component files from assets (needed for file:// pages)
                allowFileAccessFromFileURLs = true
                allowUniversalAccessFromFileURLs = true
            }
            webChromeClient = WebChromeClient()
            webViewClient = WebViewClient() // Keep navigation inside the app
        }
        setContentView(webView)
        try {
            webView.loadUrl("file:///android_asset/index.html")
        } catch (e: Exception) {
            // Fallback: load simple error page so app does not crash
            webView.loadData(
                "<html><body><p>Error loading page.</p></body></html>",
                "text/html",
                "UTF-8"
            )
        }
    }
}
