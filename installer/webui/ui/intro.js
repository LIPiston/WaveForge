/* Steam 大屏启动动画同构复刻：白描线稿逐笔画出 → 收束 → 圆环旋转生长 →
   logo 浮现 + 品牌弧线巡游 → 变速穿越退场。
   手柄线稿换成"显示器 + 声波"电脑形（WaveForge 本体是音乐播放器），
   Steam 蓝紫弧换成品牌蓝青渐变。SVG pathLength 归一化驱动描线节奏。 */
(function () {
  'use strict'

  // 电脑线稿（单笔主轮廓 + 内部细节，48×48 视窗）：
  // 主轮廓 = 显示器外框 + 立柱 + 底座 连成一笔（对应 Steam 手柄一笔轮廓），末段带回钩
  var MAIN_OUTLINE = 'M9 9 H39 Q42.5 9 42.5 12.5 V26 Q42.5 29.5 39 29.5 H26.5 V34.5 H35.5 Q38 34.5 38 36.75 Q38 39 35.5 39 H12.5 Q10 39 10 36.75 Q10 34.5 12.5 34.5 H21.5 V29.5 H9 Q5.5 29.5 5.5 26 V12.5 Q5.5 9 9 9 Z'
    // 内部细节（白描，随后几笔画出）：声波中轴 + 内外两层弧（无摇杆小圆，WaveForge 没有摇杆）
    var STROKES = [
      // 声波中轴
      { d: 'M19 19.5 H29' },
      // 内层声波弧（左右）
      { d: 'M16 16.5 Q18.5 19.5 16 22.5 M32 16.5 Q29.5 19.5 32 22.5' },
      // 外层声波弧（左右）
      { d: 'M12.5 14.5 Q16.5 19.5 12.5 24.5 M35.5 14.5 Q31.5 19.5 35.5 24.5' },
    ]
  // 蓝青渐变高亮笔画（并行扫入的点缀，对应 Steam 蓝笔画）
  var ACCENT = 'M20 12.5 H28 Q29.5 12.5 29.5 14 Q29.5 15.5 28 15.5 H20 Q18.5 15.5 18.5 14 Q18.5 12.5 20 12.5 Z'

  var TIMING = {
    bgIn: 0.0,           // 背景淡入
    strokeStart: 0.35,   // 线稿起笔
    mainDur: 1.9,        // 主轮廓单笔时长（Steam 主笔画的地位）
    strokeEach: 0.5,     // 细节每笔时长
    strokeGap: 0.22,     // 细节笔间间隔
    holdLine: 0.5,       // 线稿完整后悬停
    morph: 0.65,         // 交接拍：线稿放大退灰 + 彗星头续笔成环
    ringGrow: 0.75,      // 圆环旋转生长
    logoIn: 0.45,        // logo 浮现
    orbit: 4.2,          // 弧线巡游一圈时长
    holdLogo: 1.15,      // logo 悬停
  }

  function svgEl(tag, attrs) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', tag)
    for (var k in attrs) el.setAttribute(k, attrs[k])
    return el
  }

  function buildStage(root) {
    var NS = 'http://www.w3.org/2000/svg'

    // 线稿舞台（48 视窗放大到 200px）：主轮廓一笔 + 细节三笔 + 高亮一笔
    var svg1 = svgEl('svg', { viewBox: '0 0 48 48', class: 'sk-stage' })
    var defs = svgEl('defs')
    var grad = svgEl('linearGradient', { id: 'wf-sk-grad', x1: '0%', y1: '0%', x2: '100%', y2: '100%' })
    grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#5b9bff' }))
    grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#2bd4b0' }))
    defs.appendChild(grad)
    svg1.appendChild(defs)

    var main = svgEl('path', { d: MAIN_OUTLINE, class: 'sk-stroke sk-main', style: '--i:0' })
    main.setAttribute('pathLength', '1')
    svg1.appendChild(main)
    STROKES.forEach(function (s, i) {
      var p = svgEl('path', { d: s.d, class: 'sk-stroke', style: '--i:' + (i + 1) })
      p.setAttribute('pathLength', '1')
      svg1.appendChild(p)
    })
    var acc = svgEl('path', { d: ACCENT, class: 'sk-stroke sk-accent', style: '--i:4' })
    acc.setAttribute('pathLength', '1')
    svg1.appendChild(acc)
    root.querySelector('.sk-draw').appendChild(svg1)

    // logo 舞台：圆环（描线生长）+ 品牌弧线（巡游）+ logo 图片
    var svg2 = svgEl('svg', { viewBox: '0 0 48 48', class: 'sk-stage sk-stage2' })
    var defs2 = svgEl('defs')
    var grad2 = svgEl('linearGradient', { id: 'wf-orb-grad', x1: '0%', y1: '0%', x2: '100%', y2: '100%' })
    grad2.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#5b9bff' }))
    grad2.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#2bd4b0' }))
    defs2.appendChild(grad2)
    svg2.appendChild(defs2)
    var ring = svgEl('circle', { cx: '24', cy: '24', r: '20', class: 'sk-ring' })
    ring.setAttribute('pathLength', '1')
    svg2.appendChild(ring)
    svg2.appendChild(svgEl('circle', { cx: '24', cy: '24', r: '22.5', class: 'sk-orbit' }))
    root.querySelector('.sk-logo').appendChild(svg2)
    var img = document.createElement('img')
    img.className = 'sk-img'
    img.src = window.WF_LOGO || ''
    root.querySelector('.sk-logo').appendChild(img)
    // 彗星头：交接拍沿圆环扫一周的亮白光点（图2 里那道"续笔"的光）
    var cometOrbit = document.createElement('div')
    cometOrbit.className = 'sk-comet-orbit'
    var comet = document.createElement('div')
    comet.className = 'sk-comet'
    cometOrbit.appendChild(comet)
    root.querySelector('.sk-logo').appendChild(cometOrbit)
  }

  function playIntro() {
    var layer = document.getElementById('transition-layer')
    try { if (window.WFIntro) {} } catch (e) {}
    if (!layer) { try { window.WaveInstaller.debugLog('intro: no layer') } catch (e) {} return }
    try { window.WaveInstaller.debugLog('intro: playing reduced=' + window.matchMedia('(prefers-reduced-motion: reduce)').matches) } catch (e) {}

    layer.innerHTML =
      '<div class="tr-mask"></div>' +
      '<div class="tr-glow"></div>' +
      '<div class="tr-dots"></div>' +
      '<div class="sk-center">' +
      '  <div class="sk-draw"></div>' +
      '  <div class="sk-logo"><img class="sk-img" alt=""></div>' +
      '</div>'
    layer.style.setProperty('--tr-bg1', '#141b3f')
    layer.style.setProperty('--tr-bg2', '#0c1226')
    layer.style.setProperty('--tr-bg3', '#05070f')
    layer.style.setProperty('--tr-glow', 'rgba(91,155,255,0.20)')
    layer.style.setProperty('--tr-dot', '#7fa8ff')
    buildPhyllotaxis(layer.querySelector('.tr-dots'))
    buildStage(layer)

    // 时序：CSS 变量驱动，与 TIMING 对齐
    var s = TIMING
    var lineDone = s.strokeStart + s.mainDur + 3 * s.strokeGap + s.holdLine
    layer.style.setProperty('--t-stroke', s.strokeStart + 's')
    layer.style.setProperty('--t-each', s.strokeEach + 's')
    layer.style.setProperty('--t-gap', s.strokeGap + 's')
    layer.style.setProperty('--t-main', s.mainDur + 's')
    layer.style.setProperty('--t-line-done', lineDone + 's')
    layer.style.setProperty('--t-morph', s.morph + 's')
    layer.style.setProperty('--t-ring', lineDone + 's')
    layer.style.setProperty('--t-ringgrow', s.ringGrow + 's')
    layer.style.setProperty('--t-logoin', s.logoIn + 's')
    layer.style.setProperty('--t-orbit', s.orbit + 's')

    layer.classList.add('active', 'steam')
    // 页面内容已就绪且被动画盖住，揭掉加载期防闪页遮罩
    document.body.classList.add('ready')
    // 同步音效（自动播放策略下可能被拦，静默忽略）
    try { if (window.WFSound) window.WFSound.play() } catch (e) {}
    var totalHold = (parseFloat(layer.style.getPropertyValue('--t-ring')) + s.ringGrow + s.logoIn + s.holdLogo) * 1000
    setTimeout(function () {
      layer.classList.add('exit')
      setTimeout(function () { layer.classList.remove('active', 'exit', 'steam'); layer.innerHTML = '' }, 700)
    }, totalHold)
  }

  // 黄金角点阵（Steam 同款 phyllotaxis，确定性布点）
  var GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
  function buildPhyllotaxis(wrap) {
    var N = 220
    for (var i = 0; i < N; i++) {
      var r01 = Math.sqrt((i + 0.5) / N)
      var ang = i * GOLDEN_ANGLE
      var seed = (i * 31 + 17) % 97
      var d = document.createElement('span')
      d.className = 'tr-dot'
      d.style.left = (50 + Math.cos(ang) * r01 * 46) + '%'
      d.style.top = (50 + Math.sin(ang) * r01 * 46 * 0.86) + '%'
      d.style.width = d.style.height = (2 + (seed % 3) * 0.7) + 'px'
      d.style.setProperty('--o', ((0.55 - r01 * 0.26) * (0.65 + ((seed % 5) / 5) * 0.35)).toFixed(2))
      d.style.animationDelay = (1.15 + (i % 40) * 0.01) + 's'
      wrap.appendChild(d)
    }
  }

  window.WFIntro = { play: playIntro }
})()
