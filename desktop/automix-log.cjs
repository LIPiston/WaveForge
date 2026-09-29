/**
 * AutoMix 后端诊断日志：automix 全链路（下载/分析/渲染/AI 混音）关键事件
 * 同时写控制台和 userData/automix-backend.log。
 *
 * 用途：真机调试——用户在前端操作时，后端把每一步（策略、缓存、渲染结果、
 * 回退原因）落盘，开发/合并 AI 直接读文件即可，无需复制粘贴终端输出。
 */

const fs = require('fs')
const path = require('path')

let logPath = null

// 轮转上限：超过 5MB 滚动为 .old（只保留一份旧档），防止挂机听歌数月后日志涨到 GB 级
const LOG_MAX_BYTES = 5 * 1024 * 1024

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(logPath)
    if (stat.size > LOG_MAX_BYTES) {
      const oldPath = logPath + '.old'
      try { fs.rmSync(oldPath, { force: true }) } catch { /* ignore */ }
      fs.renameSync(logPath, oldPath)
    }
  } catch {
    // 文件不存在等：直接按无轮转处理
  }
}

function init(app) {
  if (!app || !app.getPath) return
  try {
    logPath = path.join(app.getPath('userData'), 'automix-backend.log')
  } catch {
    logPath = null
  }
  // 启动即写入首行：确保日志文件一定存在，便于确认应用跑的是含日志的代码
  automixLog('init', `automix log initialized, userData=${logPath || 'unknown'}`)
}

function automixLog(scope, message) {
  const line = `[${new Date().toISOString()}] [AutoMix-Backend][${scope}] ${message}`
  console.log(line)
  if (logPath) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
      rotateIfNeeded()
      fs.appendFileSync(logPath, line + '\n')
    } catch {
      // 日志写入失败不影响主流程
    }
  }
}

function getLogPath() {
  return logPath
}

module.exports = { init, automixLog, log: automixLog, getLogPath }
