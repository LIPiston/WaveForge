'use strict'

function createTaskbarWidgetPolling({ poll, intervalMs = 120, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  let timer = null
  let currentIntervalMs = intervalMs

  function start() {
    if (timer !== null) return
    timer = setIntervalFn(poll, currentIntervalMs)
  }

  function stop() {
    if (timer === null) return
    clearIntervalFn(timer)
    timer = null
  }

  // 运行中调整轮询间隔（游戏模式降频：光标检测从 120ms 放宽，减少常驻唤醒）
  function setPollingInterval(nextMs) {
    const value = Math.max(60, Math.round(Number(nextMs) || intervalMs))
    if (value === currentIntervalMs) return
    currentIntervalMs = value
    if (timer !== null) {
      clearIntervalFn(timer)
      timer = setIntervalFn(poll, currentIntervalMs)
    }
  }

  function bindWindow(window) {
    window.on('show', start)
    window.on('hide', stop)
    window.on('closed', stop)
    if (window.isVisible()) start()
  }

  return { bindWindow, start, stop, setPollingInterval }
}

module.exports = { createTaskbarWidgetPolling }
