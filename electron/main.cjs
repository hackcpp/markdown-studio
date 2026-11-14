const { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, shell } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { watch } = require('chokidar')
const { Workspace } = require('./workspace.cjs')
const { LocalState } = require('./local-state.cjs')
const { SearchIndex } = require('./search.cjs')
const { newNote, touchNote, noteInfo, updateInfo } = require('./metadata.cjs')

protocol.registerSchemesAsPrivileged([{ scheme: 'note-image', privileges: { standard: true, secure: true } }])
let window
let workspace
let watcher
let token
let tail = Promise.resolve()
let index
const state = () => new LocalState(path.join(app.getPath('userData'), 'sessions'))

function handle(channel, task) {
  ipcMain.handle('workspace:' + channel, (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('无效的工作区请求')
    }
    const result = tail.then(() => task(...args))
    tail = result.catch(() => {})
    return result
  })
}

function operation(channel, task) {
  handle(channel, (scope, ...args) => {
    if (!workspace || scope !== token) throw new Error('工作区已切换')
    return task(workspace, ...args)
  })
}

function signal(scope, error) {
  if (scope === token && window && !window.isDestroyed()) {
    window.webContents.send('workspace:changed', { token: scope, error })
  }
}

async function openWorkspace(directory) {
  const next = await Workspace.open(directory)
  const nodes = await next.tree()
  const session = await state().load(next.root)
  await state().remember(next.root)
  await watcher?.close()
  workspace = next
  const scope = token = randomUUID()
  watcher = watch(next.root, {
    ignoreInitial: true,
    followSymlinks: false,
    // WSL 的 Windows 挂载目录可能收不到 Windows 应用的文件通知。
    usePolling: Boolean(process.env.WSL_DISTRO_NAME && /^\/mnt\/[a-z]\//.test(next.root + '/')),
    interval: 500,
    ignored: file => path.relative(next.root, file).split(path.sep).some(part => part.startsWith('.'))
  })
  watcher.on('ready', () => signal(scope))
  watcher.on('all', () => signal(scope))
  watcher.on('error', error => signal(scope, error.message))
  return { token, name: path.basename(next.root) || next.root, nodes, session }
}

handle('choose', async () => {
  const selection = await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
  if (selection.canceled) return null
  return openWorkspace(selection.filePaths[0])
})
handle('resume', async () => {
  const recent = await state().recent()
  if (!recent) return null
  try {
    return await openWorkspace(recent)
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null
    throw error
  }
})
operation('session', (ws, session) => state().save(ws.root, session))
operation('search', (ws, query) => {
  index ??= new SearchIndex(path.join(app.getPath('userData'), 'search.sqlite'))
  return index.search(ws, query)
})
operation('tree', ws => ws.tree())
operation('read', (ws, file) => ws.read(file))
operation('copyCode', (_ws, text) => clipboard.writeText(text))
operation('openExternal', (_ws, address) => {
  const url = new URL(address)
  if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) throw new Error('不支持此链接协议')
  return shell.openExternal(url.href)
})
operation('info', (_ws, content) => noteInfo(content))
operation('updateInfo', (_ws, content, title, tags) => updateInfo(content, title, tags))
operation('save', (ws, file, content, base, overwrite) => ws.save(file, content, base, overwrite
  ? async disk => {
    const directory = path.join(app.getPath('userData'), 'recovery')
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const backup = path.join(directory, randomUUID() + '.json')
    const handle = await fs.open(backup, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify({ workspace: ws.root, path: file, content: disk }))
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  : undefined, true, touchNote))
operation('create', (ws, dir, name, folder) => ws.create(dir, name, folder,
  folder ? '' : newNote(name.replace(/\.md$/i, ''))))
operation('move', (ws, file, dir, name) => ws.move(file, dir, name))
operation('trash', (ws, file) => ws.trash(file, target => shell.trashItem(target)))
operation('paste', (ws, file) => {
  const image = clipboard.readImage()
  if (image.isEmpty()) throw new Error('剪贴板中没有图片')
  return ws.paste(file, image.toPNG())
})

function createWindow() {
  window = new BrowserWindow({
    width: 1320,
    height: 850,
    minWidth: 700,
    minHeight: 460,
    ...(process.platform === 'win32' && {
      icon: path.join(__dirname, 'markdown-studio.ico')
    }),
    backgroundColor: '#f5f6f8',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(window, {
      type: 'warning',
      message: '仍有正在保存的笔记、未保存的草稿或待处理的冲突。',
      buttons: ['返回编辑器', '直接退出'],
      defaultId: 0,
      cancelId: 0
    })
    if (choice === 1) event.preventDefault()
  })
  window.on('closed', () => { window = null })
  window.loadFile(path.join(__dirname, '../dist/index.html'))
}

if (!app.requestSingleInstanceLock()) app.quit()
else app.whenReady().then(() => {
  protocol.handle('note-image', async request => {
    try {
      const url = new URL(request.url)
      if (request.method !== 'GET' || url.hostname !== token || !workspace) return new Response(null, { status: 404 })
      const { file, type } = await workspace.image(decodeURIComponent(url.pathname.slice(1)))
      return new Response(await fs.readFile(file), {
        headers: { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
      })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
  createWindow()
  app.on('activate', () => { if (!window) createWindow() })
  app.on('second-instance', () => {
    if (!window) return createWindow()
    if (window.isMinimized()) window.restore()
    window.focus()
  })
})
app.on('window-all-closed', () => {
  void watcher?.close()
  watcher = workspace = token = null
  if (process.platform !== 'darwin') app.quit()
})
