package com.waveforge.android

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.util.AttributeSet
import android.view.View
import android.view.animation.LinearInterpolator
import kotlin.math.sin

/**
 * TV 端全屏启动动画（主风格与 PC splash 一致：深色底 + 居中 logo + 音波条），
 * 针对电视重新设计：元素更大、居中偏上，加入「涟漪」扩散动画呼应澜音水主题。
 * 后端就绪后由 MainActivity 淡出移除。
 */
class SplashView @JvmOverloads constructor(
    context: Context,
    private val versionName: String = "",
    attrs: AttributeSet? = null,
) : View(context, attrs) {

    private val accent = Color.parseColor("#4fc3f7")
    private val ink = Color.parseColor("#0a0f14")
    private val dot = resources.displayMetrics.density

    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = 36 * dot
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        textAlign = Paint.Align.CENTER
    }
    private val subPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#8b9bb4")
        textSize = 15 * dot
        textAlign = Paint.Align.CENTER
    }
    private val ripplePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 3 * dot
        color = accent
    }
    private val logoPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = accent }
    private val notePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ink }
    private val barPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = accent }

    private val animator = ValueAnimator.ofFloat(0f, 1f).apply {
        duration = 2400
        repeatCount = ValueAnimator.INFINITE
        interpolator = LinearInterpolator()
        addUpdateListener { invalidate() }
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        animator.start()
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        animator.cancel()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        val cx = w / 2f
        val progress = animator.animatedValue as Float

        // 入场：前 35% 时间内 logo 从 0.8 放大到 1 并淡入
        val enter = if (progress < 0.35f) progress / 0.35f else 1f
        val eased = enter * enter * (3f - 2f * enter) // smoothstep
        val scale = 0.8f + 0.2f * eased
        val alpha = (eased * 255).toInt()

        val cy = h * 0.42f
        val logoCy = cy - 10 * dot

        // 涟漪：logo 外扩散的三圈循环
        for (i in 0 until 3) {
            val off = (progress + i / 3f) % 1f
            val radius = (50 * dot + off * 150 * dot) * scale
            ripplePaint.alpha = ((1f - off) * 150).toInt()
            canvas.drawCircle(cx, logoCy, radius, ripplePaint)
        }

        // logo：圆形底 + 双音符
        logoPaint.alpha = alpha
        val logoR = 46 * dot * scale
        canvas.drawCircle(cx, logoCy, logoR, logoPaint)

        notePaint.alpha = alpha
        val ncx = cx
        val ncy = logoCy
        val lx = ncx - 14 * dot * scale
        val rx = ncx + 13 * dot * scale
        canvas.drawCircle(lx, ncy - 2 * dot * scale, 9 * dot * scale, notePaint)
        canvas.drawCircle(rx, ncy + 7 * dot * scale, 9 * dot * scale, notePaint)
        canvas.drawRect(lx - 2 * dot, ncy - 2 * dot * scale - 26 * dot * scale, lx + 2 * dot, ncy - 2 * dot * scale, notePaint)
        canvas.drawRect(rx - 2 * dot, ncy + 7 * dot * scale - 26 * dot * scale, rx + 2 * dot, ncy + 7 * dot * scale, notePaint)

        // 标题与版本
        textPaint.alpha = alpha
        canvas.drawText("WaveForge", cx, cy + 64 * dot, textPaint)
        subPaint.alpha = alpha
        canvas.drawText("澜音工坊 · 版本 ${versionName.ifEmpty { "0.1.3" }}", cx, cy + 94 * dot, subPaint)

        // 底部音波条（7 根，正弦起伏）
        val barY = h * 0.72f
        val barW = 6 * dot
        val gap = 17 * dot
        for (i in 0 until 7) {
            val phase = progress * Math.PI * 2 * 1.5 + i * 0.85
            val amp = (0.5 + 0.5 * sin(phase)).toFloat()
            val bh = (10 + 26 * amp) * dot
            val x = cx + (i - 3) * gap
            canvas.drawRect(x - barW / 2, barY - bh / 2, x + barW / 2, barY + bh / 2, barPaint)
        }
    }
}
