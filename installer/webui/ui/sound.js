/* 安装器开场音效（WebAudio 实时合成，零音频资源文件）
 *
 * 节奏对齐 intro.js 的 Steam 同构时序，三段式：
 *   1) 嗖（whoosh）  线稿起笔时：粉噪 + 带通扫频，气流从低到高滑升 —— Steam 的进场感
 *   2) 嗡（hum）     圆环生长时：低频正弦涌起 + 五度泛音，"引擎点火"般的恢弘底座
 *   3) 澜（water）   logo 浮现时：水滴坠入 + 湖面涟漪泛音 —— WaveForge 的水声特色，
 *                    结尾挂一个明亮的大三度和弦，收在"开门见山"的预期里
 *
 * 全程峰值 ≈ -16dB，克制不吵；AudioContext 懒创建（自动播放策略：WebView2 首次
 * 用户手势后允许出声，开场自动播失败时静默跳过，不影响安装流程）。
 */
(function () {
  'use strict'

  var ctx = null
  // 预热：脚本加载即创建 context（越早创建，浏览器越可能将其标记为可出声）
  try {
    var AC = window.AudioContext || window.webkitAudioContext
    if (AC) ctx = new AC()
  } catch (e) { ctx = null }

  function ac() {
    if (!ctx) {
      var AC2 = window.AudioContext || window.webkitAudioContext
      if (!AC2) return null
      ctx = new AC2()
    }
    if (ctx.state === 'suspended') { try { ctx.resume() } catch (e) {} }
    return ctx
  }

  /* 粉噪 buffer（Paul Kellet 近似，1.5s 循环足够） */
  var noiseBuf = null
  function noise(c) {
    if (noiseBuf) return noiseBuf
    var len = Math.floor(c.sampleRate * 1.5)
    noiseBuf = c.createBuffer(1, len, c.sampleRate)
    var d = noiseBuf.getChannelData(0)
    var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
    for (var i = 0; i < len; i++) {
      var w = Math.random() * 2 - 1
      b0 = 0.99886 * b0 + w * 0.0555179
      b1 = 0.99332 * b1 + w * 0.0750759
      b2 = 0.969 * b2 + w * 0.153852
      b3 = 0.8665 * b3 + w * 0.3104856
      b4 = 0.55 * b4 + w * 0.5329522
      b5 = -0.7616 * b5 - w * 0.016898
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11
      b6 = w * 0.115926
    }
    return noiseBuf
  }

  /* 单音：osc + 增益包络（attack/decay/release 线性近似） */
  function tone(c, out, o) {
    var osc = c.createOscillator()
    var g = c.createGain()
    osc.type = o.type || 'sine'
    osc.frequency.setValueAtTime(o.freq, c.currentTime + o.at)
    if (o.glideTo) osc.frequency.exponentialRampToValueAtTime(o.glideTo, c.currentTime + o.at + o.dur)
    g.gain.setValueAtTime(0, c.currentTime + o.at)
    g.gain.linearRampToValueAtTime(o.gain, c.currentTime + o.at + (o.attack || 0.02))
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + o.at + o.dur)
    osc.connect(g).connect(out)
    osc.start(c.currentTime + o.at)
    osc.stop(c.currentTime + o.at + o.dur + 0.05)
  }

  /* whoosh：粉噪 + 带通中心滑频 */
  function whoosh(c, out, at, dur, from, to, level) {
    var src = c.createBufferSource()
    src.buffer = noise(c)
    src.loop = true
    var bp = c.createBiquadFilter()
    bp.type = 'bandpass'
    bp.Q.value = 1.1
    bp.frequency.setValueAtTime(from, c.currentTime + at)
    bp.frequency.exponentialRampToValueAtTime(to, c.currentTime + at + dur)
    var g = c.createGain()
    g.gain.setValueAtTime(0, c.currentTime + at)
    g.gain.linearRampToValueAtTime(level, c.currentTime + at + dur * 0.45)
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + at + dur)
    src.connect(bp).connect(g).connect(out)
    src.start(c.currentTime + at)
    src.stop(c.currentTime + at + dur + 0.05)
  }

  /* 水滴：正弦快速下滑 + 短促（叮-咚 的"咚"） */
  function droplet(c, out, at, baseFreq, level) {
    tone(c, out, { freq: baseFreq * 2.2, type: 'sine', at: at, dur: 0.11, gain: level, glideTo: baseFreq })
    tone(c, out, { freq: baseFreq * 1.5, type: 'sine', at: at + 0.09, dur: 0.28, gain: level * 0.7, glideTo: baseFreq * 0.75 })
  }

  function play() {
    var c = ac()
    if (!c) return
    /* 自动播放策略：context 被挂起时改挂"首次手势"监听，用户一点立即补播 */
    if (c.state !== 'running') {
      var retry = function () {
        document.removeEventListener('pointerdown', retry)
        if (c.state === 'running') playShort()
        else play()
      }
      document.addEventListener('pointerdown', retry)
      try { c.resume() } catch (e) {}
      if (c.state !== 'running') return
    }
    playFull(c)
  }

  /* 完整版：三段式（嗖/嗡/澜），与开场动画逐拍对齐 */
  function playFull(c) {
    var master = c.createGain()
    master.gain.value = 0.5 // 峰值 ≈ -16dB
    master.connect(c.destination)

    /* 与 intro.js TIMING 对齐：起笔 0.35s，圆环 2.85s，logo ≈ 3.85s */
    var T = { stroke: 0.35, ring: 2.85, logo: 3.85 }

    /* 1) 嗖 —— 线稿逐笔（0.35s-2.9s）：两段气流，随笔画滑升 */
    whoosh(c, master, T.stroke, 1.2, 220, 950, 0.28)
    whoosh(c, master, T.stroke + 1.25, 1.3, 500, 1600, 0.22)

    /* 2) 嗡 —— 圆环生长（2.85s 起）：低频点火 + 五度，恢弘底座 */
    tone(c, master, { freq: 55, type: 'sine', at: T.ring, dur: 2.6, gain: 0.30, attack: 0.35 })
    tone(c, master, { freq: 110, type: 'sine', at: T.ring + 0.05, dur: 2.4, gain: 0.16, attack: 0.4 })
    tone(c, master, { freq: 165, type: 'triangle', at: T.ring + 0.1, dur: 2.2, gain: 0.07, attack: 0.5 })
    /* 高频 shimmer 一闪（圆环画满的瞬间） */
    tone(c, master, { freq: 2093, type: 'sine', at: T.ring + 0.55, dur: 0.5, gain: 0.05 })

    /* 3) 澜 —— logo 浮现（3.85s 起）：水滴 + 涟漪 + 收束和弦 */
    droplet(c, master, T.logo, 392, 0.22)                    // G4 水滴
    tone(c, master, { freq: 784, type: 'sine', at: T.logo + 0.14, dur: 1.4, gain: 0.10, attack: 0.05 })   // G5 涟漪
    tone(c, master, { freq: 1174.7, type: 'sine', at: T.logo + 0.2, dur: 1.3, gain: 0.06 })                // D6
    /* 大三度和弦收束（G major：G-B-D），温暖开阔 */
    tone(c, master, { freq: 392, type: 'sine', at: T.logo + 0.5, dur: 1.8, gain: 0.09, attack: 0.25 })
    tone(c, master, { freq: 493.9, type: 'sine', at: T.logo + 0.56, dur: 1.7, gain: 0.07, attack: 0.3 })
    tone(c, master, { freq: 587.3, type: 'sine', at: T.logo + 0.62, dur: 1.6, gain: 0.06, attack: 0.35 })
  }

  /* 快速版：自动播放被拦后的手势补播——只播"嗡+澜"精华段（约 2s） */
  function playShort() {
    var c = ac()
    if (!c) return
    var master = c.createGain()
    master.gain.value = 0.5
    master.connect(c.destination)
    tone(c, master, { freq: 55, type: 'sine', at: 0, dur: 1.4, gain: 0.28, attack: 0.08 })
    tone(c, master, { freq: 110, type: 'sine', at: 0.03, dur: 1.3, gain: 0.14, attack: 0.1 })
    droplet(c, master, 0.25, 392, 0.22)
    tone(c, master, { freq: 784, type: 'sine', at: 0.4, dur: 1.2, gain: 0.1, attack: 0.05 })
    tone(c, master, { freq: 392, type: 'sine', at: 0.62, dur: 1.4, gain: 0.09, attack: 0.2 })
    tone(c, master, { freq: 493.9, type: 'sine', at: 0.68, dur: 1.3, gain: 0.07, attack: 0.25 })
    tone(c, master, { freq: 587.3, type: 'sine', at: 0.74, dur: 1.2, gain: 0.06, attack: 0.3 })
  }

  window.WFSound = { play: play }
})()
