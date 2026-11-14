const { contextBridge, ipcRenderer } = require('electron')

const api = {}
for (const action of ['choose', 'resume', 'session', 'search', 'rebuildIndex', 'checkWorkspace', 'tree', 'read', 'movedNote', 'copyCode', 'openExternal', 'info', 'updateInfo', 'save', 'create', 'move', 'trashPreview', 'trash', 'paste']) {
  api[action] = (...args) => ipcRenderer.invoke('workspace:' + action, ...args)
}
api.onChanged = listener => {
  const handle = (_event, change) => listener(change)
  ipcRenderer.on('workspace:changed', handle)
  return () => ipcRenderer.removeListener('workspace:changed', handle)
}
contextBridge.exposeInMainWorld('notes', api)
