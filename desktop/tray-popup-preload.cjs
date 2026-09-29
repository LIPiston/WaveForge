const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('trayPopup', {
  onState: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('tray-popup:state', listener)
    return () => ipcRenderer.removeListener('tray-popup:state', listener)
  },
  // 高频增量（歌名/播放态/音量变化），页面自行合并
  onPartial: (callback) => {
    const listener = (_event, partial) => callback(partial)
    ipcRenderer.on('tray-popup:partial', listener)
    return () => ipcRenderer.removeListener('tray-popup:partial', listener)
  },
  action: (action, payload) => ipcRenderer.send('tray-popup:action', action, payload),
  showMain: () => ipcRenderer.send('tray-popup:show-main'),
  setFeature: (name, enabled) => ipcRenderer.send('tray-popup:set-feature', name, enabled),
  getUsage: () => ipcRenderer.invoke('tray-popup:get-usage'),
})
