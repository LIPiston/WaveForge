const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('lyricsIsland', {
  getState: () => ipcRenderer.invoke('lyrics-island:get-state'),
  getSettings: () => ipcRenderer.invoke('lyrics-island:get-settings'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('lyrics-island:state', listener)
    return () => ipcRenderer.removeListener('lyrics-island:state', listener)
  },
  onSettings: (callback) => {
    const listener = (_event, settings) => callback(settings)
    ipcRenderer.on('lyrics-island:settings', listener)
    return () => ipcRenderer.removeListener('lyrics-island:settings', listener)
  },
  updateSettings: (partial) => ipcRenderer.invoke('lyrics-island:update-settings', partial),
  sendControl: (action) => ipcRenderer.send('lyrics-island:control', action),
  startDrag: (point) => ipcRenderer.send('lyrics-island:drag-start', point),
  dragTo: (point) => ipcRenderer.send('lyrics-island:drag-to', point),
  endDrag: () => ipcRenderer.send('lyrics-island:drag-end'),
})
