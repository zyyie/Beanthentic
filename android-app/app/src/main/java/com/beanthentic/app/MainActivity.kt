package com.beanthentic.app

import android.annotation.SuppressLint
import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Bundle
import android.os.SystemClock
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.view.animation.AccelerateDecelerateInterpolator
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    @SuppressLint("SetJavaScriptEnabled")
    @Suppress("DEPRECATION")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val container = FrameLayout(this)

        // Main WebView
        val webView = WebView(this)
        container.addView(
            webView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )

        // Loading overlay (coffee bean in brown)
        val loadingOverlay = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.WHITE)
        }

        val icon = ImageView(this@MainActivity).apply {
            setImageResource(R.drawable.coffee_bean_loading)
            scaleType = ImageView.ScaleType.CENTER_INSIDE
            val sizePx = (96 * resources.displayMetrics.density).toInt()
            layoutParams = LinearLayout.LayoutParams(sizePx, sizePx)
        }

        // Coffee bean "jumping" animation
        val bounceAnimatorSet = AnimatorSet().apply {
            val jump = ObjectAnimator.ofFloat(
                icon,
                View.TRANSLATION_Y,
                0f,
                -18f,
                0f
            ).apply {
                duration = 700L
                repeatCount = ValueAnimator.INFINITE
                interpolator = AccelerateDecelerateInterpolator()
            }

            val rotate = ObjectAnimator.ofFloat(
                icon,
                View.ROTATION,
                0f,
                -10f,
                10f,
                0f
            ).apply {
                duration = 700L
                repeatCount = ValueAnimator.INFINITE
                interpolator = AccelerateDecelerateInterpolator()
            }

            val scaleX = ObjectAnimator.ofFloat(
                icon,
                View.SCALE_X,
                1f,
                1.06f,
                1f
            ).apply {
                duration = 700L
                repeatCount = ValueAnimator.INFINITE
                interpolator = AccelerateDecelerateInterpolator()
            }

            val scaleY = ObjectAnimator.ofFloat(
                icon,
                View.SCALE_Y,
                1f,
                1.06f,
                1f
            ).apply {
                duration = 700L
                repeatCount = ValueAnimator.INFINITE
                interpolator = AccelerateDecelerateInterpolator()
            }

            playTogether(jump, rotate, scaleX, scaleY)
        }

        val text = TextView(this@MainActivity).apply {
            text = "Please wait for a moment."
            setTextColor(Color.GRAY)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            paint.isFakeBoldText = false
            paint.isAntiAlias = true
        }

        loadingOverlay.addView(icon)
        loadingOverlay.addView(text)

        container.addView(
            loadingOverlay,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )

        loadingOverlay.visibility = View.VISIBLE
        setContentView(container)

        webView.settings.apply {
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

        var loadStartTimeMs = 0L
        var hideScheduled = false
        var minVisibleMs = 1200L
        var progressReached100 = false
        val maxFallbackMs = 5000L
        var hideRunnable: Runnable? = null

        fun showLoading() {
            hideScheduled = false
            loadStartTimeMs = SystemClock.uptimeMillis()
            progressReached100 = false
            hideRunnable?.let { loadingOverlay.removeCallbacks(it) }
            loadingOverlay.visibility = View.VISIBLE
            bounceAnimatorSet.start()
        }

        fun scheduleHideAfter(delayMs: Long) {
            if (hideScheduled) return
            hideScheduled = true

            val runnable = hideRunnable ?: Runnable {
                loadingOverlay.visibility = View.GONE
                bounceAnimatorSet.cancel()
            }.also { hideRunnable = it }

            loadingOverlay.postDelayed(runnable, delayMs)
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                super.onProgressChanged(view, newProgress)
                // Keep overlay until the WebView reports full progress.
                if (newProgress >= 100) {
                    progressReached100 = true
                    val elapsed = SystemClock.uptimeMillis() - loadStartTimeMs
                    val delay = (minVisibleMs - elapsed).coerceAtLeast(0L)
                    scheduleHideAfter(delay)
                }
            }
        }

        try {
            webView.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView?,
                    request: WebResourceRequest?
                ): Boolean {
                    // Any navigation inside the WebView should show loading.
                    showLoading()
                    return false
                }

                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                    showLoading()
                    super.onPageStarted(view, url, favicon)
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    // Safety fallback: if progress never reaches 100, hide after a max time.
                    if (!progressReached100) {
                        val elapsed = SystemClock.uptimeMillis() - loadStartTimeMs
                        val delay = (maxFallbackMs - elapsed).coerceAtLeast(0L)
                        scheduleHideAfter(delay)
                    }
                    super.onPageFinished(view, url)
                }

                override fun onReceivedError(
                    view: WebView?,
                    request: WebResourceRequest?,
                    error: WebResourceError?
                ) {
                    bounceAnimatorSet.cancel()
                    loadingOverlay.visibility = View.GONE
                    super.onReceivedError(view, request, error)
                }
            }

            showLoading()
            webView.loadUrl("file:///android_asset/index.php")
        } catch (e: Exception) {
            // Fallback: load simple error page so app does not crash
            webView.loadData(
                "<html><body><p>Error loading page.</p></body></html>",
                "text/html",
                "UTF-8"
            )
            loadingOverlay.visibility = View.GONE
            bounceAnimatorSet.cancel()
        }
    }
}
