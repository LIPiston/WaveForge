/* WaveForge 安装向导 v2 · 全新流程与视觉 */
(function () {
  'use strict'

  var $ = function (id) { return document.getElementById(id) }
  var host = window.WaveInstaller
  var t = function (k, p) { return window.InstallerI18N.t(k, p) }

  var state = {
    page: 'welcome',
    theme: 'dark',
    lang: 'zh-CN',
    scope: 'current',
    dir: '',
    dirTouched: false,
    desktopShortcut: true,
    agreed: false,
    licenseBottom: false,
    custom: false,
    installing: false,
    bs: null,
  }

  /* ---------- 小工具 ---------- */
  function fmtSize(mb) {
    if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB'
    return Math.round(mb) + ' MB'
  }
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  function toast(text) {
    var el = $('toast')
    el.textContent = text
    el.classList.remove('hidden')
    el.classList.add('show')
    clearTimeout(el.__t)
    el.__t = setTimeout(function () { el.classList.remove('show'); el.classList.add('hidden') }, 1800)
  }
  function showModal(title, body, yesText, onYes) {
    $('modal-title').textContent = title
    $('modal-body').textContent = body
    $('modal-yes').textContent = yesText
    $('modal-mask').classList.remove('hidden')
    $('modal-mask').__onYes = onYes
  }
  function hideModal() { $('modal-mask').classList.add('hidden') }

  /* ---------- 背景特效：极光 + 波浪 + 粒子（含鼠标视差） ---------- */
  var canvas = $('fx')
  var ctx = canvas.getContext('2d')
  var W = 0, H = 0
  var mouse = { x: 0.5, y: 0.5 }
  var speed = 1, speedTarget = 1
  var particles = []
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  function palette() {
    if (state.theme === 'dark') {
      return {
        aurora: ['rgba(91,155,255,0.15)', 'rgba(43,212,176,0.11)', 'rgba(146,108,255,0.09)', 'rgba(255,143,171,0.05)'],
        waves: ['rgba(91,155,255,0.13)', 'rgba(43,212,176,0.09)', 'rgba(91,155,255,0.06)', 'rgba(60,90,140,0.05)'],
        dots: 'rgba(159,176,200,',
        stars: 'rgba(220,235,255,',
        meteor: 'rgba(200,225,255,',
      }
    }
    return {
      aurora: ['rgba(91,155,255,0.20)', 'rgba(43,212,176,0.14)', 'rgba(146,108,255,0.10)', 'rgba(255,183,197,0.08)'],
      waves: ['rgba(36,101,206,0.10)', 'rgba(6,139,116,0.08)', 'rgba(36,101,206,0.05)', 'rgba(22,33,58,0.04)'],
      dots: 'rgba(93,109,135,',
      stars: 'rgba(90,110,150,',
      meteor: 'rgba(36,101,206,',
    }
  }
  function resizeCanvas() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2)
    W = canvas.clientWidth; H = canvas.clientHeight
    canvas.width = W * dpr; canvas.height = H * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    particles = []
    var n = Math.round(Math.min(70, W / 16))
    for (var i = 0; i < n; i++) {
      particles.push({
        x: Math.random() * W, y: Math.random() * H,
        r: 0.8 + Math.random() * 2.2,
        vy: 0.12 + Math.random() * 0.4,
        vx: (Math.random() - 0.5) * 0.14,
        a: 0.15 + Math.random() * 0.4,
        depth: 0.3 + Math.random() * 0.7,
        tw: Math.random() * Math.PI * 2,          // 闪烁相位
        tws: 0.5 + Math.random() * 1.6,           // 闪烁速度
      })
    }
    meteors = []
    for (var m = 0; m < 3; m++) meteors.push(newMeteor(true))
  }
  var meteors = []
  function newMeteor(anywhere) {
    return {
      x: Math.random() * W * 1.2 - W * 0.1,
      y: anywhere ? Math.random() * H * 0.5 : -30,
      vx: 2.2 + Math.random() * 2.4,
      vy: 1.1 + Math.random() * 0.9,
      life: 0, ttl: 1.4 + Math.random() * 1.2,
      len: 90 + Math.random() * 120,
      wait: anywhere ? Math.random() * 6 : 2 + Math.random() * 5,
    }
  }
  var t0 = Date.now()
  function drawFx() {
    var t = (Date.now() - t0) / 1000
    speed += (speedTarget - speed) * 0.03
    var pal = palette()
    ctx.clearRect(0, 0, W, H)

    // 极光团（四层，各自独立漂浮）
    var blobs = [
      { x: W * (0.18 + Math.sin(t * 0.11) * 0.06) + mouse.x * 26, y: H * (0.2 + Math.cos(t * 0.13) * 0.05) + mouse.y * 18, r: H * 0.66, c: pal.aurora[0] },
      { x: W * (0.85 + Math.cos(t * 0.09) * 0.05) + mouse.x * -20, y: H * (0.3 + Math.sin(t * 0.1) * 0.06) + mouse.y * -14, r: H * 0.54, c: pal.aurora[1] },
      { x: W * (0.55 + Math.sin(t * 0.07 + 2) * 0.08) + mouse.x * 14, y: H * (0.85 + Math.cos(t * 0.08) * 0.03), r: H * 0.58, c: pal.aurora[2] },
      { x: W * (0.38 + Math.cos(t * 0.06 + 4) * 0.1) + mouse.x * -10, y: H * (0.12 + Math.sin(t * 0.05 + 1) * 0.05), r: H * 0.42, c: pal.aurora[3] },
    ]
    for (var b = 0; b < blobs.length; b++) {
      var bl = blobs[b]
      var g = ctx.createRadialGradient(bl.x, bl.y, 0, bl.x, bl.y, bl.r)
      g.addColorStop(0, bl.c)
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, W, H)
    }

    // 波浪（澜）— 四层
    for (var i = 0; i < 4; i++) {
      var amp = 22 + i * 12
      var yBase = H * (0.62 + i * 0.1)
      var spd = (0.5 + i * 0.2) * speed
      var k = 0.9 - i * 0.15
      ctx.beginPath()
      ctx.moveTo(-20, H + 20)
      for (var x = -20; x <= W + 20; x += 7) {
        var y = yBase + Math.sin(x / 175 * k + t * spd + i * 2.1) * amp + Math.sin(x / 63 - t * spd * 0.6) * (amp * 0.3)
        ctx.lineTo(x, y)
      }
      ctx.lineTo(W + 20, H + 20)
      ctx.closePath()
      ctx.fillStyle = pal.waves[i]
      ctx.fill()
    }

    // 星尘闪烁 + 粒子（视差）
    var mx = (mouse.x - 0.5) * 26, my = (mouse.y - 0.5) * 18
    for (var p = 0; p < particles.length; p++) {
      var pt = particles[p]
      pt.y -= pt.vy * speed
      pt.x += pt.vx * speed
      if (pt.y < -6) { pt.y = H + 6; pt.x = Math.random() * W }
      if (pt.x < -6) pt.x = W + 6
      if (pt.x > W + 6) pt.x = -6
      var twA = pt.a * (0.62 + 0.38 * Math.sin(t * pt.tws + pt.tw))
      ctx.beginPath()
      ctx.arc(pt.x + mx * pt.depth, pt.y + my * pt.depth, pt.r, 0, Math.PI * 2)
      ctx.fillStyle = pal.dots + twA.toFixed(3) + ')'
      ctx.fill()
    }

    // 流星（低频划过，渐隐尾迹）
    for (var m = 0; m < meteors.length; m++) {
      var mt = meteors[m]
      if (mt.wait > 0) { mt.wait -= 0.016 * speed; continue }
      mt.life += 0.016 * speed
      mt.x += mt.vx * speed * 2
      mt.y += mt.vy * speed * 2
      var lifeFrac = mt.life / mt.ttl
      if (lifeFrac >= 1) { meteors[m] = newMeteor(false); continue }
      var fade = lifeFrac < 0.2 ? lifeFrac / 0.2 : 1 - (lifeFrac - 0.2) / 0.8
      var tailX = mt.x - mt.vx * (mt.len / 3)
      var tailY = mt.y - mt.vy * (mt.len / 3)
      var mg = ctx.createLinearGradient(mt.x, mt.y, tailX, tailY)
      mg.addColorStop(0, pal.meteor + (0.75 * fade).toFixed(3) + ')')
      mg.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.strokeStyle = mg
      ctx.lineWidth = 1.6
      ctx.beginPath()
      ctx.moveTo(mt.x, mt.y)
      ctx.lineTo(tailX, tailY)
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(mt.x, mt.y, 1.6, 0, Math.PI * 2)
      ctx.fillStyle = pal.meteor + (0.9 * fade).toFixed(3) + ')'
      ctx.fill()
    }

    if (!reduced) requestAnimationFrame(drawFx)
  }

  /* ---------- 开场启动动画（约 2.4s，仅首次进入时播一次） ---------- */
  /* ---------- 开场启动动画：Steam 大屏同构，引擎在 intro.js ---------- */
  function playIntro() { window.WFIntro.play() }
  /* ---------- 退出 / 取消 ---------- */
  function go(page) {
    var old = document.querySelector('.page.active')
    if (old && old.id !== 'page-' + page) {
      old.classList.remove('active')
      old.classList.add('leaving')
      setTimeout(function () { old.classList.remove('leaving') }, 380)
    }
    var el = $('page-' + page)
    void el.offsetWidth
    el.classList.add('active')
    state.page = page
    speedTarget = page === 'progress' ? 3 : 1
    if (page === 'license') setTimeout(function () { $('license-box').focus() }, 80)
  }
  function primaryEnabled() {
    if (state.page === 'welcome') return true
    if (state.page === 'license') return state.agreed
    if (state.page === 'options') return !$('btn-options-install').disabled
    if (state.page === 'finish') return true
    return false
  }
  function primaryAction() {
    if (state.page === 'welcome') startQuick()
    else if (state.page === 'license' && state.agreed) proceedAfterLicense()
    else if (state.page === 'options' && primaryEnabled()) startInstall()
    else if (state.page === 'finish') finishRun()
  }

  /* ---------- ① 欢迎 ---------- */
  function applyTheme(theme) {
    state.theme = theme
    document.documentElement.setAttribute('data-theme', theme)
  }

  /* ---------- 多语言 ---------- */
  function applyI18n() {
    document.documentElement.lang = state.lang
    var bs = state.bs || {}
    var product = bs.productName || 'WaveForge'
    $('tb-title').textContent = product + ' · ' + t('setup')
    document.title = product + ' ' + t('setup')
    $('btn-quick').innerHTML = escapeHtml(t('quick')) + '<small id="quick-desc">' + escapeHtml(t('installTo', { dir: bs.dirCurrent || '' })) + '</small>'
    $('btn-custom').textContent = t('custom')
    $('welcome-foot').innerHTML = t('foot')
    $('license-title').textContent = t('licenseTitle')
    $('license-sub').textContent = t('licenseSub')
    $('agree-text').innerHTML = escapeHtml(t('agreeText')) + '<em id="agree-hint">' + escapeHtml(t('agreeHint')) + '</em>'
    $('btn-license-back').textContent = t('disagree')
    $('btn-license-next').textContent = t('agreeNext')
    $('options-title').textContent = t('optionsTitle')
    $('options-sub').textContent = t('optionsSub')
    $('label-scope').textContent = t('scopeLabel')
    var segs = $('scope-seg').querySelectorAll('.seg')
    segs[0].innerHTML = '<b>' + escapeHtml(t('scopeCur')) + '</b><i>' + escapeHtml(t('scopeCurHint')) + '</i>'
    segs[1].innerHTML = '<b>' + escapeHtml(t('scopeAll')) + '</b><i>' + escapeHtml(t('scopeAllHint')) + '</i>'
    $('label-dir').textContent = t('dirLabel')
    $('btn-browse').textContent = t('browse')
    $('label-disk').textContent = t('diskLabel')
    $('opt-text').textContent = t('shortcut')
    $('btn-options-back').textContent = t('back')
    $('btn-options-install').textContent = t('startInstall')
    var phMap = { extract: 'phExtract', finish: 'phFinish', done: 'phDone' }
    var chips = document.querySelectorAll('.phase')
    for (var i = 0; i < chips.length; i++) {
      var key = phMap[chips[i].getAttribute('data-ph')]
      if (key) chips[i].textContent = t(key)
    }
    $('btn-install-cancel').textContent = t('cancelInstall')
    $('finish-title').textContent = t('finishTitle')
    $('btn-finish-run').textContent = t('launch')
    // 卸载页元素（若当前为卸载模式）
    var unTitle = $('un-title')
    if (unTitle) {
      $('un-dir').textContent = t('unDir', { dir: state.bs ? state.bs.dirCurrent || '' : '' })
      $('un-warning').textContent = t('unWarning')
      $('un-run-text').textContent = t('unRun')
      $('btn-uninstall-cancel').textContent = t('unCancel')
      $('unprog-title').textContent = t('unProgTitle')
      $('unprog-sub').textContent = t('unProgSub')
      $('unfinish-title').textContent = t('unFinishTitle')
      $('btn-unfinish-close').textContent = t('unClose')
      var kl = $('un-keep-label')
      if (kl) kl.textContent = t('unKeepLabel')
      var runDesc = $('un-run-desc')
      if (runDesc && state.bs) {
        var ts = ''
        var its = state.unItems || []
        for (var qi = 0; qi < its.length; qi++) if (its[qi].key === 'dir:install' && its[qi].size) ts = its[qi].size
        runDesc.textContent = ts ? t('unRunDescSize', { size: ts }) : ''
      }
    }
    $('pick-title-el').textContent = t('pickTitle')
    $('pick-up').textContent = t('up')
    $('pick-new').textContent = t('newFolder')
    $('pick-new-ok').textContent = t('create')
    $('pick-cancel').textContent = t('cancel')
    $('pick-ok').textContent = t('pickOk')
    $('pick-new-name').placeholder = t('newNamePh')
    if (bs.priorVer) {
      var chip = $('chip-upgrade')
      chip.textContent = t('upgraded', { v: bs.priorVer })
      chip.classList.remove('hidden')
    }
    var ver = bs.version || ''
    if (!ver || /probe|preview/i.test(ver)) ver = window.WF_VERSION || ver
    var isPreview = bs.mode === 'preview' || /probe|preview/i.test(bs.version || '')
    $('chip-version').textContent = window.InstallerI18N.versionDisplay(ver, isPreview)
    renderDrives()
    if (state.page === 'license') renderLicense()
  }

  function buildLangMenu() {
    var menu = $('lang-menu')
    var html = ''
    var langs = window.InstallerI18N.LANGS
    for (var i = 0; i < langs.length; i++) {
      html += '<button class="lang-item' + (langs[i].code === state.lang ? ' current' : '') + '" data-lang="' + langs[i].code + '">'
        + '<span class="lang-short">' + langs[i].short + '</span>' + langs[i].label + '</button>'
    }
    menu.innerHTML = html
    var items = menu.querySelectorAll('.lang-item')
    for (var j = 0; j < items.length; j++) {
      items[j].addEventListener('click', function () {
        setLang(this.getAttribute('data-lang'))
        $('lang-menu').classList.add('hidden')
      })
    }
  }
  function setLang(lang) {
    state.lang = lang
    window.InstallerI18N.setLang(lang)
    applyI18n()
  }
  function startQuick() {
    state.custom = false
    go('license')
  }
  function startCustom() {
    state.custom = true
    go('license')
  }

  /* ---------- ② 协议（按语言渲染） ---------- */
  function renderLicense() {
    var text = (window.WF_AGREEMENTS && (window.WF_AGREEMENTS[state.lang] || window.WF_AGREEMENTS['zh-CN'])) || '（协议内容缺失）'
    var html = ''
    var lines = text.split('\n')
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
      if (!line.trim()) continue
      if (/^##\s*/.test(line.trim())) html += '<h4>' + escapeHtml(line.trim().replace(/^##\s*/, '')) + '</h4>'
      else if (/^\s*[—–-]{1,2}\s*WaveForge/i.test(line)) html += '<p class="sign-off">' + escapeHtml(line.trim()) + '</p>'
      else html += '<p>' + escapeHtml(line) + '</p>'
    }
    $('license-content').innerHTML = html
  }
  function initLicense() {
    var box = $('license-box')
    renderLicense()
    function onScroll() {
      if (state.licenseBottom) return
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 26) {
        state.licenseBottom = true
        $('agree-check').disabled = false
        $('agree-hint').textContent = ''
      }
    }
    box.addEventListener('scroll', onScroll)
    setTimeout(onScroll, 250)
    $('agree-check').addEventListener('click', function () {
      if (this.disabled) return
      state.agreed = !state.agreed
      this.classList.toggle('checked', state.agreed)
      $('btn-license-next').disabled = !state.agreed
    })
    // 点文字同样可以勾选，更顺手
    $('agree-text').addEventListener('click', function () {
      if (!$('agree-check').disabled) $('agree-check').click()
    })
  }

  /* ---------- ③ 自定义选项 ---------- */
  function driveLetterOf(p) { var m = (p || '').match(/^([a-zA-Z]:)/); return m ? m[1].toUpperCase() : '' }
  function renderDrives() {
    var est = state.bs ? state.bs.estMb : 0
    var wrap = $('drives')
    var chosen = driveLetterOf(state.dir)
    var html = ''
    var drives = state.bs.drives || []
    for (var i = 0; i < drives.length; i++) {
      var d = drives[i]
      var usedPct = Math.max(0, Math.min(100, ((d.total - d.free) / d.total) * 100))
      var enough = d.free > est * 1.1
      html += '<button class="drive' + (d.root === chosen ? ' active' : '') + '" data-root="' + d.root + '">'
        + '<span class="drive-top"><b>' + d.root + '\\</b>'
        + '<i>' + fmtSize(d.free) + ' / ' + fmtSize(d.total) + '</i>'
        + (enough ? '' : '<em class="lack">' + escapeHtml(t('lack')) + '</em>') + '</span>'
        + '<span class="drive-bar"><span class="drive-used" style="width:' + usedPct + '%"></span></span>'
        + '</button>'
    }
    wrap.innerHTML = html
    var cards = wrap.querySelectorAll('.drive')
    for (var j = 0; j < cards.length; j++) {
      cards[j].addEventListener('click', function () {
        setDir(this.getAttribute('data-root') + '\\WaveForge', true)
      })
    }
  }
  function setDir(v, byUser) {
    state.dir = v
    if (byUser) state.dirTouched = true
    $('dir-input').value = v
    refreshDirState()
  }
  function validatePath(raw) {
    var p = (raw || '').trim()
    if (!p) return t('pathEmpty')
    var last = p.charAt(p.length - 1)
    if (last === ' ' || last === '.') return t('pathEnd')
    if (/^\\\\[?.]\\/.test(p)) return t('pathDevice')
    if (p.indexOf('\\\\') === 0) return t('pathUnc')
    if (!(/^[a-zA-Z]:/.test(p) && p.charAt(2) === '\\')) return t('pathAbs')
    var bad = p.slice(2).match(/[:*?"<>|]/)
    if (bad) return t('pathChars', { c: bad[0] })
    var base = p.replace(/[\\/]+$/, '').split('\\').pop() || ''
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(base)) return t('pathReserved')
    return ''
  }
  function refreshDirState() {
    var err = validatePath(state.dir)
    var msg = $('dir-msg')
    var btn = $('btn-options-install')
    if (err) {
      msg.textContent = err
      msg.className = 'dir-msg bad'
      btn.disabled = true
      updateSummary(null)
      renderDrives()
      return
    }
    msg.textContent = ''
    msg.className = 'dir-msg'
    host.getDriveSpace(state.dir).then(function (sp) {
      try {
        updateSummary(sp)
        renderDrives()
      } catch (err) { try { host.debugLog('refreshDirState render fail: ' + err.message + '\n' + err.stack) } catch (e2) {} }
      if (!sp || sp.total === 0) {
        msg.textContent = '目标磁盘不可用。'
        msg.className = 'dir-msg bad'
        btn.disabled = true
        return
      }
      var need = state.bs.estMb * 1.1 + 64
      if (sp.free < need) {
        msg.textContent = t('diskShort', { free: fmtSize(sp.free), need: fmtSize(need) })
        msg.className = 'dir-msg bad'
        btn.disabled = true
      } else {
        btn.disabled = false
      }
    }).catch(function () { btn.disabled = false })
  }
  function updateSummary(sp) {
    var el = $('space-summary')
    if (!sp) { el.textContent = ''; el.classList.remove('lack'); return }
    el.textContent = t('spaceSummary', { a: fmtSize(state.bs.estMb), b: fmtSize(sp.free) })
    el.classList.toggle('lack', sp.free < state.bs.estMb * 1.1 + 64)
  }

  /* ---------- ④ 进度 ---------- */
  var shownPercent = 0
  var speeds = []
  var sparkCtx = null
  function drawSparkline() {
    var c = $('sparkline')
    if (!c) return
    if (!sparkCtx) sparkCtx = c.getContext('2d')
    var dpr = Math.min(window.devicePixelRatio || 1, 2)
    var w = c.clientWidth - 8, h = c.clientHeight - 8
    if (c.width !== (w + 8) * dpr) { c.width = (w + 8) * dpr; c.height = (h + 8) * dpr }
    sparkCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
    sparkCtx.clearRect(0, 0, w + 8, h + 8)
    var ox = 4, oy = 4
    var pal = state.theme === 'dark' ? 'rgba(91,155,255,' : 'rgba(36,101,206,'
    var grid = state.theme === 'dark' ? 'rgba(140,170,210,0.10)' : 'rgba(22,33,58,0.08)'
    // 背景网格线（三档刻度）
    sparkCtx.strokeStyle = grid
    sparkCtx.lineWidth = 1
    for (var gy = 1; gy <= 3; gy++) {
      var yy = oy + (h * gy) / 3.5
      sparkCtx.beginPath(); sparkCtx.moveTo(ox, yy); sparkCtx.lineTo(ox + w, yy); sparkCtx.stroke()
    }
    if (speeds.length < 2) return
    // y 轴动态缩放：以最近窗口的 min/max 为准（平线也居中显示，波动立刻放大细节）
    var sMin = Math.min.apply(null, speeds)
    var sMax = Math.max.apply(null, speeds)
    var span = Math.max(sMax - sMin, sMax * 0.08, 1) // 最小跨度防抖
    var lo = Math.max(0, sMin - span * 0.15)
    var hi = sMax + span * 0.15
    function yPos(v) { return oy + h - 4 - ((v - lo) / (hi - lo)) * (h - 8) }
    // 填充面积
    sparkCtx.beginPath()
    for (var i = 0; i < speeds.length; i++) {
      var x = ox + (i / (speeds.length - 1)) * w
      var y = yPos(speeds[i])
      if (i === 0) sparkCtx.moveTo(x, y)
      else sparkCtx.lineTo(x, y)
    }
    sparkCtx.lineTo(ox + w, oy + h); sparkCtx.lineTo(ox, oy + h); sparkCtx.closePath()
    var g = sparkCtx.createLinearGradient(0, oy, 0, oy + h)
    g.addColorStop(0, pal + '0.4)')
    g.addColorStop(1, pal + '0.03)')
    sparkCtx.fillStyle = g
    sparkCtx.fill()
    // 曲线 + 端点
    sparkCtx.beginPath()
    for (var j = 0; j < speeds.length; j++) {
      var x2 = ox + (j / (speeds.length - 1)) * w
      var y2 = yPos(speeds[j])
      if (j === 0) sparkCtx.moveTo(x2, y2)
      else sparkCtx.lineTo(x2, y2)
    }
    sparkCtx.strokeStyle = pal + '0.95)'
    sparkCtx.lineWidth = 2
    sparkCtx.stroke()
    var lx = ox + w, ly = yPos(speeds[speeds.length - 1])
    sparkCtx.beginPath(); sparkCtx.arc(lx - 1, ly, 3, 0, Math.PI * 2)
    sparkCtx.fillStyle = pal + '1)'; sparkCtx.fill()
  }
  function startInstall() {
    if (state.installing) return
    // 根目录（如 D:\）自动落位到 X:\WaveForge，避免散落盘根
    var m = state.dir.match(/^([a-zA-Z]:)\\?$/)
    if (m) {
      state.dir = m[1] + '\\WaveForge'
      $('dir-input').value = state.dir
      toast(t('autoDir', { dir: state.dir }))
    }
    var btn = $('btn-options-install')
    btn.disabled = true
    host.probeWritable(state.dir).then(function (ok) {
      if (!ok) throw new Error('writable')
      return host.startInstall({ dir: state.dir, scope: state.scope, desktopShortcut: state.desktopShortcut })
    }).then(function () {
      state.installing = true
      shownPercent = 0; targetPercent = 0
      shownMb = 0; targetMb = 0
      shownSpeed = 0; targetSpeed = 0
      speeds = []
      doneReached = false
      $('install-target').textContent = t('target', { dir: state.dir })
      setPhase('extract')
      go('progress')
      btn.disabled = false
    }).catch(function (e) {
      btn.disabled = false
      var msg = $('dir-msg')
      msg.className = 'dir-msg bad'
      msg.textContent = e && e.message === 'writable'
        ? t('notWritable')
        : (e && e.message === 'elevate-cancelled' ? t('elevCancelled') : t('startFail'))
    })
  }
  function setPhase(ph) {
    var chips = document.querySelectorAll('.phase')
    var order = ['extract', 'finish', 'done']
    var idx = order.indexOf(ph)
    for (var i = 0; i < chips.length; i++) {
      chips[i].classList.toggle('active', i === idx)
      chips[i].classList.toggle('done', i < idx)
    }
  }
  /* ---------- 进度平滑层：目标值来自壳轮询，显示值逐帧缓动逼近 ----------
     NSIS 解压是文件级突发（500ms 轮询间数字跳 10-20%），直接渲染就割裂；
     显示侧用 rAF 每帧向目标靠拢 + 最小推进速度，肉眼永远是连续爬升。 */
  var shownPercent = 0        // 显示中的百分比（浮点）
  var targetPercent = 0       // 壳回报的最新目标
  var shownMb = 0             // 显示中的已写入 MB（同龟速追目标）
  var targetMb = 0
  var rafId = 0
  var lastFrameAt = 0
  var speeds = []             // 平滑后的速度历史（画折线）
  var shownSpeed = 0          // 显示中的速度
  var targetSpeed = 0
  var doneReached = false

  function tickProgress(now) {
    if (!state.installing) { rafId = 0; return }
    var dt = lastFrameAt ? Math.min(0.1, (now - lastFrameAt) / 1000) : 0.016
    lastFrameAt = now
    // 百分比：指数逼近（越接近目标越慢）+ 最低 4%/s 的推进感
    var gap = targetPercent - shownPercent
    if (gap > 0.01) {
      var step = Math.max(gap * Math.min(1, dt * 3.2), 4 * dt * (gap > 1 ? 1 : 0))
      shownPercent = Math.min(targetPercent, shownPercent + step)
    }
    // MB 同步逼近
    var mbGap = targetMb - shownMb
    if (mbGap > 0.05) shownMb += Math.min(mbGap, Math.max(mbGap * dt * 3.2, (targetPercent > 0 ? targetMb / targetPercent : 0) * shownPercent * 0.002 + 2 * dt))
    if (shownMb > targetMb) shownMb = targetMb
    // 速度：向目标缓动（轮询间隙不摔到 0）
    shownSpeed += (targetSpeed - shownSpeed) * Math.min(1, dt * 4)
    renderProgress()
    rafId = requestAnimationFrame(tickProgress)
  }

  function renderProgress() {
    var pct = Math.max(0, Math.min(100, shownPercent))
    $('bar-fill').style.width = pct + '%'
    document.querySelector('.bar-stripes').style.setProperty('--p', pct + '%')
    $('percent-num').textContent = Math.round(pct)
    $('stat-size').textContent = fmtSize(shownMb) + ' / ' + fmtSize(state.bs ? state.bs.estMb || targetMb : targetMb)
    if (shownSpeed > 0.5) {
      var remainMb = Math.max(0, (state.bs ? state.bs.estMb || 0 : 0) - shownMb)
      var eta = remainMb > 1 ? t('eta', { n: Math.max(1, Math.round(remainMb / shownSpeed)) }) : t('etaSoon')
      $('stat-eta').textContent = '≈ ' + Math.round(shownSpeed) + ' MB/s · ' + eta
    } else {
      $('stat-eta').textContent = ''
    }
    drawSparkline()
  }

  function onProgress(d) {
    if (state.page !== 'progress' || !state.installing) return
    targetPercent = Math.max(targetPercent, Math.min(100, d.percent || 0))
    targetMb = Math.max(targetMb, d.copiedMb || 0)
    targetSpeed = d.speedMbps && Number(d.speedMbps) > 0 ? Number(d.speedMbps) : targetSpeed * 0.82
    if (targetSpeed > 0) {
      speeds.push(targetSpeed)
      if (speeds.length > 48) speeds.shift()
    }
    if (!rafId) {
      lastFrameAt = 0
      rafId = requestAnimationFrame(tickProgress)
    }
    if (d.phase === 'done') {
      // 收尾：目标直接拉满，缓动走完最后一段再进完成页
      targetPercent = 100
      targetMb = state.bs ? Math.max(targetMb, state.bs.estMb || targetMb) : targetMb
      setPhase('finish')
      setTimeout(function () {
        state.installing = false
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0 }
        setPhase('done')
        go('finish')
        confettiBurst()
      }, 950)
    } else if (d.phase === 'error') {
      setPhase('extract')
      $('stat-eta').textContent = t('errProblem')
    }
  }

  /* ---------- ⑤ 完成 ---------- */
  var confettiCtx = null
  function confettiBurst() {
    if (reduced) return
    var c = $('confetti')
    var dpr = Math.min(window.devicePixelRatio || 1, 2)
    c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr
    var cx = c.getContext('2d')
    cx.setTransform(dpr, 0, 0, dpr, 0, 0)
    var W2 = c.clientWidth, H2 = c.clientHeight
    var colors = ['#5b9bff', '#2bd4b0', '#926cff', '#ffc86b', '#ff8fab']
    var parts = []
    for (var i = 0; i < 90; i++) {
      var ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.2
      var v = 5 + Math.random() * 7
      parts.push({
        x: W2 / 2, y: H2 * 0.34,
        vx: Math.cos(ang) * v, vy: Math.sin(ang) * v,
        w: 3 + Math.random() * 5, h: 2 + Math.random() * 4,
        rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
        c: colors[i % colors.length], life: 1,
      })
    }
    var start = Date.now()
    function tick() {
      var t = (Date.now() - start) / 1000
      cx.clearRect(0, 0, W2, H2)
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i]
        p.x += p.vx; p.y += p.vy; p.vy += 0.18; p.vx *= 0.99; p.rot += p.vr
        p.life = Math.max(0, 1 - t / 2.2)
        if (p.life <= 0) continue
        cx.save()
        cx.translate(p.x, p.y)
        cx.rotate(p.rot)
        cx.globalAlpha = p.life
        cx.fillStyle = p.c
        cx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h)
        cx.restore()
      }
      if (t < 2.4) requestAnimationFrame(tick)
      else cx.clearRect(0, 0, W2, H2)
    }
    requestAnimationFrame(tick)
  }
  function finishRun() { host.finish({ launch: true }) }

  /* ---------- 自绘目录浏览 ---------- */
  var pick = { path: '', prev: '' }
  function pickSegs(path) {
    if (!path) return []
    var segs = path.replace(/[\\/]+$/, '').split('\\')
    var out = []
    var acc = ''
    for (var i = 0; i < segs.length; i++) {
      acc += i === 0 ? segs[i] + '\\' : '\\' + segs[i]
      out.push({ name: segs[i], path: acc })
    }
    return out
  }
  function renderPickCrumbs() {
    var el = $('pick-crumbs')
    var html = '<button class="pick-crumb' + (pick.path === '' ? ' current' : '') + '" data-p="">' + escapeHtml(t('pc')) + '</button>'
    var segs = pickSegs(pick.path)
    for (var i = 0; i < segs.length; i++) {
      html += '<span class="pick-sep">›</span>'
        + '<button class="pick-crumb' + (i === segs.length - 1 ? ' current' : '') + '" data-p="' + escapeHtml(segs[i].path) + '\\">' + escapeHtml(segs[i].name) + '</button>'
    }
    el.innerHTML = html
    var btns = el.querySelectorAll('.pick-crumb')
    for (var j = 0; j < btns.length; j++) {
      btns[j].addEventListener('click', function () { pickEnter(this.getAttribute('data-p')) })
    }
  }
  function pickEnter(path) {
    pick.path = path || ''
    renderPickCrumbs()
    var list = $('pick-list')
    list.innerHTML = '<div class="pick-empty">' + escapeHtml(t('reading')) + '</div>'
    host.listDir(pick.path).then(function (r) {
      if (r && r.error) { list.innerHTML = '<div class="pick-empty">' + escapeHtml(r.error) + '</div>'; return }
      var dirs
      if (pick.path === '') {
        // 此电脑层：列出固定磁盘
        dirs = []
        var ds = (state.bs && state.bs.drives) || []
        for (var k = 0; k < ds.length; k++) dirs.push(ds[k].root)
      } else {
        dirs = (r && r.dirs) || []
      }
      if (!dirs.length) { list.innerHTML = '<div class="pick-empty">' + escapeHtml(t('emptyDir')) + '</div>'; return }
      var html = ''
      for (var i = 0; i < dirs.length; i++) {
        html += '<button class="pick-item" data-n="' + escapeHtml(dirs[i]) + '">'
          + '<svg viewBox="0 0 16 16"><path d="M1.5 4.5v8h13v-6.5H8L6.5 4.5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>'
          + '<span>' + escapeHtml(dirs[i]) + '</span></button>'
      }
      list.innerHTML = html
      var items = list.querySelectorAll('.pick-item')
      for (var j = 0; j < items.length; j++) {
        items[j].addEventListener('click', function () {
          var name = this.getAttribute('data-n')
          pickEnter(pick.path ? pick.path.replace(/[\\/]+$/, '') + '\\' + name : name + '\\')
        })
      }
    }).catch(function (e) {
      list.innerHTML = '<div class="pick-empty">' + escapeHtml(String(e && e.message || e)) + '</div>'
    })
  }
  function pickUp() {
    if (!pick.path) return
    var parent = pick.path.replace(/[\\/]+$/, '').replace(/\\[^\\]+$/, '')
    pickEnter(parent === pick.path.replace(/[\\/]+$/, '') ? '' : parent)
  }
  function openPicker() {
    pick.path = ''
    $('pick-new-row').classList.add('hidden')
    $('pick-mask').classList.remove('hidden')
    pickEnter('')
  }
  function closePicker() { $('pick-mask').classList.add('hidden') }
  function confirmPick() {
    var chosen = pick.path
    closePicker()
    if (!chosen) { toast('请先进入一个磁盘或文件夹'); return }
    var m = chosen.match(/^([a-zA-Z]:)\\?$/)
    if (m) {
      chosen = m[1] + '\\WaveForge'
      host.createDir(m[1] + '\\', 'WaveForge').catch(function () {})
    }
    setDir(chosen, true)
  }

  /* ---------- 退出 / 取消 ---------- */
  function requestClose() {
    if (state.installing) {
      showModal(t('cancelTitle'), t('cancelBody'), t('quit'), function () {
        host.cancelInstall().finally(function () { host.close() })
      })
    } else {
      showModal(t('quitTitle'), t('quitBody'), t('quit'), function () { host.close() })
    }
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    $('btn-theme').addEventListener('click', function () {
      applyTheme(state.theme === 'dark' ? 'light' : 'dark')
    })
    $('btn-lang').addEventListener('click', function (e) {
      e.stopPropagation()
      buildLangMenu()
      $('lang-menu').classList.toggle('hidden')
    })
    document.addEventListener('click', function (e) {
      var menu = $('lang-menu')
      if (!menu.classList.contains('hidden') && !menu.contains(e.target) && e.target !== $('btn-lang')) {
        menu.classList.add('hidden')
      }
    })
    $('btn-quick').addEventListener('click', startQuick)
    $('btn-custom').addEventListener('click', startCustom)
    $('link-agreement').addEventListener('click', function (e) { e.preventDefault(); go('license') })

    $('btn-license-back').addEventListener('click', requestClose)
    $('btn-license-next').addEventListener('click', proceedAfterLicense)

    var segs = $('scope-seg').querySelectorAll('.seg')
    for (var i = 0; i < segs.length; i++) {
      segs[i].addEventListener('click', function () {
        var scope = this.getAttribute('data-scope')
        if (scope === state.scope) return
        state.scope = scope
        for (var k = 0; k < segs.length; k++) segs[k].classList.toggle('active', segs[k] === this)
        if (!state.dirTouched || state.dir === state.bs.dirCurrent || state.dir === state.bs.dirAll) {
          state.dirTouched = false
          setDir(scope === 'all' ? state.bs.dirAll : state.bs.dirCurrent, false)
        }
        renderEnv()
      })
    }
    $('dir-input').addEventListener('input', function () {
      state.dirTouched = true
      state.dir = this.value
      refreshDirState()
    })
    $('btn-browse').addEventListener('click', openPicker)
    $('pick-cancel').addEventListener('click', closePicker)
    $('pick-mask').addEventListener('click', function (e) { if (e.target === this) closePicker() })
    $('pick-up').addEventListener('click', pickUp)
    $('pick-ok').addEventListener('click', confirmPick)
    $('pick-new').addEventListener('click', function () {
      var row = $('pick-new-row')
      row.classList.remove('hidden')
      $('pick-new-name').value = ''
      $('pick-new-name').focus()
    })
    $('pick-new-cancel').addEventListener('click', function () { $('pick-new-row').classList.add('hidden') })
    $('pick-new-ok').addEventListener('click', function () {
      var name = $('pick-new-name').value.trim()
      if (!name) return
      if (!pick.path) { toast(t('pickRootFirst')); return }
      host.createDir(pick.path, name).then(function () {
        $('pick-new-row').classList.add('hidden')
        pickEnter(pick.path)
      }).catch(function (e) { toast(e && e.message || t('createFail')) })
    })
    $('pick-new-name').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('pick-new-ok').click()
      if (e.key === 'Escape') $('pick-new-row').classList.add('hidden')
    })
    $('shortcut-switch').addEventListener('click', function () {
      state.desktopShortcut = !state.desktopShortcut
      this.classList.toggle('on', state.desktopShortcut)
      this.setAttribute('aria-checked', state.desktopShortcut ? 'true' : 'false')
    })
    $('btn-options-back').addEventListener('click', function () { go('license') })
    $('btn-options-install').addEventListener('click', startInstall)

    $('btn-install-cancel').addEventListener('click', requestClose)
    $('btn-finish-run').addEventListener('click', finishRun)

    $('btn-min').addEventListener('click', function () { host.minimize() })
    $('btn-close').addEventListener('click', requestClose)
    $('btn-uninstall-run').addEventListener('click', runUninstall)
    $('btn-uninstall-cancel').addEventListener('click', function () { host.close() })
    $('btn-unfinish-close').addEventListener('click', function () { host.finish({ launch: false }) })
    $('modal-no').addEventListener('click', hideModal)
    $('modal-yes').addEventListener('click', function () {
      var fn = $('modal-mask').__onYes
      hideModal()
      if (fn) fn()
    })
    $('modal-mask').addEventListener('click', function (e) { if (e.target === this) hideModal() })

    document.addEventListener('keydown', function (e) {
      if (!$('modal-mask').classList.contains('hidden')) {
        if (e.key === 'Escape') hideModal()
        if (e.key === 'Enter') { var fn = $('modal-mask').__onYes; hideModal(); if (fn) fn() }
        return
      }
      if (e.key === 'Enter' && primaryEnabled()) { e.preventDefault(); primaryAction() }
      else if (e.key === 'Escape' && state.page !== 'progress') requestClose()
    })

    window.addEventListener('mousemove', function (e) {
      mouse.x = e.clientX / window.innerWidth
      mouse.y = e.clientY / window.innerHeight
    })
    window.addEventListener('resize', resizeCanvas)
  }

  // 快速安装：协议通过后直接以默认参数开装；自定义则进入选项页
  function proceedAfterLicense() {
    if (state.custom) { go('options'); return }
    state.scope = 'current'
    state.desktopShortcut = true
    setDir(state.bs.dirCurrent || '', false)
    var btn = $('btn-options-install')
    btn.disabled = false
    startInstall()
  }

  /* ---------- 启动 ---------- */
  function init(bootstrap) {
    state.bs = bootstrap
    applyTheme('dark')
    state.lang = window.InstallerI18N.detect()
    var qm = /[?&]lang=([a-zA-Z-]+)/.exec(location.search)
    if (qm && /^(zh-CN|zh-TW|en|ja|ko)$/.test(qm[1])) state.lang = qm[1]
    window.InstallerI18N.setLang(state.lang)
    try { host.debugLog('init lang=' + state.lang + ' search=' + location.search) } catch (e) {}
    $('hero-logo').src = window.WF_LOGO || ''
    $('tb-logo').src = window.WF_LOGO || ''
    initLicense()
    state.scope = bootstrap.scope || 'current'
    var segs = $('scope-seg').querySelectorAll('.seg')
    for (var i = 0; i < segs.length; i++) segs[i].classList.toggle('active', segs[i].getAttribute('data-scope') === state.scope)
    setDir(bootstrap.dirCurrent || '', false)
    host.onUpdate(onProgress)
    applyI18n()
    if (bootstrap.uninstall) {
      document.body.classList.add('ready')
      initUninstall(bootstrap)
      return
    }
    go('welcome')
    playIntro()
  }

  /* ---------- 卸载流程 ---------- */
  var unItems = []
  var unKeepKeys = []
  function initUninstall(bootstrap) {
    $('un-logo').src = window.WF_LOGO || ''
    $('un-title').textContent = t('unTitle')
    $('un-dir').textContent = t('unDir', { dir: bootstrap.dirCurrent || '' })
    $('un-size').textContent = ''
    $('un-warning').textContent = t('unWarning')
    $('un-run-text').textContent = t('unRun')
    $('btn-uninstall-cancel').textContent = t('unCancel')
    $('unprog-title').textContent = t('unProgTitle')
    $('unprog-sub').textContent = t('unProgSub')
    $('unfinish-title').textContent = t('unFinishTitle')
    $('btn-unfinish-close').textContent = t('unClose')
    var keepLabel = $('un-keep-label')
    if (keepLabel) keepLabel.textContent = t('unKeepLabel')
    host.scanUninstall().then(function (r) {
      unItems = r.items || []
      var totalSize = ''
      for (var q = 0; q < unItems.length; q++) if (unItems[q].key === 'dir:install' && unItems[q].size) totalSize = unItems[q].size
      if (totalSize) $('un-size').textContent = totalSize
      var runDesc = $('un-run-desc')
      if (runDesc) runDesc.textContent = totalSize ? t('unRunDescSize', { size: totalSize }) : ''
      var wrap = $('un-keep-list')
      var html = ''
      for (var i = 0; i < unItems.length; i++) {
        if (!unItems[i].keepable || !unItems[i].exists) continue
        html += '<div class="un-keep-item" data-key="' + unItems[i].key + '">'
          + '<button class="checkbox checked" aria-label="keep"><svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>'
          + '<span><b>' + escapeHtml(unItems[i].label) + '</b><i>' + escapeHtml((unItems[i].detail || '').indexOf('wf-un-') === 0 ? t('detail_' + unItems[i].detail) : (unItems[i].detail || '')) + '</i></span>'
          + '<span class="keep-tag">' + escapeHtml(t('unWillKeep')) + '</span></div>'
      }
      wrap.innerHTML = html
      var items = wrap.querySelectorAll('.un-keep-item')
      for (var j = 0; j < items.length; j++) {
        items[j].addEventListener('click', function () {
          var cb = this.querySelector('.checkbox')
          cb.classList.toggle('checked')
          var tag = this.querySelector('.keep-tag')
          if (tag) tag.textContent = cb.classList.contains('checked') ? t('unWillKeep') : t('unWillDelete')
        })
      }
      go('uninstall')
      if (bootstrap.autodemoDelete) {
        var boxes = wrap.querySelectorAll('.checkbox.checked')
        for (var k = 0; k < boxes.length; k++) boxes[k].click()
      }
      if (bootstrap.autodemo || bootstrap.autodemoDelete) setTimeout(runUninstall, 1500)
    })
  }
  function runUninstall() {
    var keep = []
    unKeepKeys = []
    var items = document.querySelectorAll('.un-keep-item')
    for (var i = 0; i < items.length; i++) {
      if (items[i].querySelector('.checkbox').classList.contains('checked')) {
        keep.push(items[i].getAttribute('data-key'))
        unKeepKeys.push(items[i].getAttribute('data-key'))
      }
    }
    go('unprogress')
    var logBox = $('un-log')
    logBox.innerHTML = ''
    var done = 0
    var total = unItems.length
    function stepProgress() {
      var pct = total ? Math.min(100, (done / total) * 100) : 0
      $('un-bar-fill').style.width = pct + '%'
      $('un-bar-stripes').style.setProperty('--p', pct + '%')
      $('un-stat-count').textContent = t('unCount', { done: done, total: total })
      var cur = done < total ? (unItems[done] ? unItems[done].label : '') : ''
      $('un-stat-cur').textContent = cur
    }
    stepProgress()
    host.killApp().then(function () { return host.runUninstall(keep) }).then(function (r) {
      var logs = r.logs || []
      total = logs.length
      var next = function () {
        if (done >= logs.length) {
          stepProgress()
          var showResidue = unKeepKeys.length > 0
          var residueBox = $('un-residue')
          if (residueBox) {
            residueBox.classList.toggle('hidden', !showResidue)
            if (showResidue) {
              var ud = ''
              for (var q = 0; q < unItems.length; q++) if (unItems[q].key === 'ud:settings') ud = unItems[q].baseDir || ''
              $('un-residue-path').textContent = ud
            }
          }
          var sub = $('unfinish-sub')
          if (sub) sub.textContent = showResidue ? t('unFinishKeptSub') : t('unFinishSub')
          setTimeout(function () {
            go('unfinish')
            confettiBurst()
            setTimeout(function () {
              try {
                var pg = document.getElementById('page-unfinish')
                var kids = []
                for (var ki = 0; ki < pg.children.length; ki++) {
                  var kc = pg.children[ki]
                  kids.push(kc.tagName + '#' + (kc.id || kc.className) + ' h=' + Math.round(kc.getBoundingClientRect().height) + ' y=' + Math.round(kc.getBoundingClientRect().top))
                }
                window.WaveInstaller.debugLog('unfinish layout: page=' + JSON.stringify(pg.getBoundingClientRect()) + ' | ' + kids.join(' | '))
              } catch (e) { window.WaveInstaller.debugLog('measure fail: ' + e.message) }
            }, 900)
          }, 750)
          return
        }
        var it = logs[done]
        done += 1
        var cls = it.ok ? (unKeepKeys.indexOf(it.key) >= 0 ? 'keep' : 'ok') : 'fail'
        var statusText = cls === 'keep' ? t('unKept') : (cls === 'fail' ? t('unFailed') : t('unDeleted'))
        var itemLabel = ''
        var itemSize = ''
        for (var q = 0; q < unItems.length; q++) if (unItems[q].key === it.key) { itemLabel = unItems[q].label; itemSize = unItems[q].size || ''; break }
        var row = document.createElement('div')
        row.className = 'un-log-item ' + cls
        row.innerHTML = '<span class="un-ic"><svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>'
          + '<span><b>' + escapeHtml(statusText) + '</b>' + escapeHtml(itemLabel || it.key) + '</span>'
          + (itemSize ? '<span class="un-size">' + escapeHtml(itemSize) + '</span>' : '')
        logBox.appendChild(row)
        logBox.scrollTop = logBox.scrollHeight
        stepProgress()
        setTimeout(next, 300)
      }
      next()
    })
  }



  window.addEventListener('error', function (e) {
    try {
      host.debugLog('window.onerror: ' + e.message + ' @' + (e.filename || '') + ':' + e.lineno
        + (e.error && e.error.stack ? '\n' + e.error.stack : ''))
    } catch (err) {}
  })
  window.addEventListener('unhandledrejection', function (e) {
    try { host.debugLog('unhandledrejection: ' + (e.reason && e.reason.message || e.reason)) } catch (err) {}
  })

  bind()
  resizeCanvas()
  if (reduced) drawFx()
  else requestAnimationFrame(drawFx)

  // 自动演示：?autodemo=1 快速通道；=custom 自定义通道；=pick 打开自绘目录选择；=uninstall 卸载全流程
  var demo = /[?&]autodemo=(custom|pick|uninstall|1)/.exec(location.search)
  if (demo && demo[1] === 'uninstall') {
    setTimeout(function () { runUninstall() }, 2500)
  } else if (demo) {
    if (demo[1] === '1') {
      setTimeout(function () { $('btn-quick').click() }, 1200)
      setTimeout(function () { var b = $('license-box'); b.scrollTop = b.scrollHeight }, 2300)
      setTimeout(function () {
        if (!$('agree-check').disabled) $('agree-check').click()
        $('btn-license-next').click()
      }, 3100)
    } else {
      setTimeout(function () { $('btn-custom').click() }, 1200)
      setTimeout(function () { var b = $('license-box'); b.scrollTop = b.scrollHeight }, 2300)
      setTimeout(function () {
        if (!$('agree-check').disabled) $('agree-check').click()
        $('btn-license-next').click()
      }, 3100)
      if (demo[1] === 'pick') {
        setTimeout(function () { $('btn-browse').click() }, 3700)
      } else {
        setTimeout(function () { $('btn-options-install').click() }, 4300)
      }
    }
  }

  host.bootstrap().then(function (bs) {
    try { init(bs) }
    catch (e) {
      try { host.debugLog('init fail: ' + (e && e.stack || e)) } catch (e2) {}
      document.body.innerHTML = '<p style="color:#eaf1fb;padding:40px;font-family:sans-serif">初始化失败：' + escapeHtml(String(e && e.message || e)) + '</p>'
    }
  }).catch(function (e) {
    document.body.innerHTML = '<p style="color:#eaf1fb;padding:40px;font-family:sans-serif">初始化失败：' + escapeHtml(String(e && e.message || e)) + '</p>'
  })
})()
