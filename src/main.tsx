import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react'
import { createRoot } from 'react-dom/client'
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Editor } from './Editor'
import type { Disk, Draft, Mode, Node, SearchResult, Session, Workspace } from './types'
import './style.css'

type Tab = { id: number; path: string; text: string; disk: Disk | null; conflict?: Disk | null; recovery?: Draft; recoveryBase?: string | null; saving?: boolean; error?: string }
type Action = 'note' | 'folder' | 'rename' | 'move' | 'trash'
const itemActions = ['rename', 'move', 'trash'] as const
type Dialog = { action: Action; path: string; name: string; directory: string }
const labels = { note: '新建笔记', folder: '新建文件夹', rename: '重命名', move: '移动', trash: '移至废纸篓' }
const dirty = (tab: Tab) => tab.text !== (tab.disk?.content ?? '')
const pending = (tab: Tab) => dirty(tab) || tab.saving || tab.conflict !== undefined || !!tab.recovery
const under = (base: string, file: string) => file === base || file.startsWith(base + '/')
const name = (file: string) => file.split('/').at(-1) ?? ''
const parent = (file: string) => file.split('/').slice(0, -1).join('/')
const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error)
const normalize = (disk: Disk | null) => disk && { ...disk, content: disk.content.replace(/\r\n?/g, '\n') }
const withoutMetadata = (text: string) => text.replace(/^(?:\uFEFF)?---[ \t]*\n(?:[\s\S]*?\n)?(?:---|\.\.\.)[ \t]*(?:\n|$)/, '')

function displayTitle(tab: Tab) {
  const metadata = tab.text.slice(0, tab.text.length - withoutMetadata(tab.text).length)
  const title = /^title:[ \t]*(.+)$/m.exec(metadata)?.[1].trim()
  return title?.replace(/^(['"])(.*)\1$/, '$2') || name(tab.path).replace(/\.md$/i, '')
}

const headingComponents: Components = {
  h1: ({ node, ...props }) => <h1 data-line={node?.position?.start.line} {...props} />,
  h2: ({ node, ...props }) => <h2 data-line={node?.position?.start.line} {...props} />,
  h3: ({ node, ...props }) => <h3 data-line={node?.position?.start.line} {...props} />,
  h4: ({ node, ...props }) => <h4 data-line={node?.position?.start.line} {...props} />,
  h5: ({ node, ...props }) => <h5 data-line={node?.position?.start.line} {...props} />,
  h6: ({ node, ...props }) => <h6 data-line={node?.position?.start.line} {...props} />
}

function Outline({ tab, preview, onJump, onClose }: {
  tab: Tab; preview: RefObject<HTMLElement | null>; onJump(line: number): void; onClose(): void
}) {
  const body = withoutMetadata(tab.text)
  const offset = tab.text.slice(0, tab.text.length - body.length).split('\n').length - 1
  const [headings, setHeadings] = useState<HTMLHeadingElement[]>([])
  useEffect(() => {
    setHeadings(Array.from(preview.current?.querySelectorAll<HTMLHeadingElement>('h1,h2,h3,h4,h5,h6') ?? []))
  }, [preview, tab.text])
  return <aside className="outline-panel">
    <div className="outline-title"><strong>文档目录</strong><button aria-label="关闭文档目录" onClick={onClose}>×</button></div>
    <nav className="outline" aria-label="文档目录">
      {headings.length === 0 ? <span>当前笔记没有标题</span> : headings.map((heading, position) =>
        <button key={position} style={{ paddingLeft: 8 + (Number(heading.tagName[1]) - 1) * 10 }}
          onClick={() => { if (heading.dataset.line) onJump(Number(heading.dataset.line) + offset) }}>{heading.textContent}</button>)}
    </nav>
    <div className="outline-title"><strong>文档信息</strong></div>
    <div className="stat"><span>字数</span><span>{counts(body).words}</span></div>
    <div className="stat"><span>字符</span><span>{counts(body).chars}</span></div>
    <div className="stat"><span>保存状态</span><span>{tabStatus(tab)}</span></div>
  </aside>
}

function counts(body: string) {
  return { words: (body.match(/\p{Script=Han}|[A-Za-z0-9_]+/gu) ?? []).length,
    chars: [...body.replace(/\s/g, '')].length }
}

function tabStatus(tab: Tab) {
  if (tab.recovery) return '等待恢复草稿'
  if (tab.error) return '保存失败'
  if (tab.conflict !== undefined) return '等待处理冲突'
  if (tab.saving) return '保存中'
  return dirty(tab) ? '未保存' : '已保存'
}

function folders(nodes: Node[]): Node[] {
  return nodes.flatMap(node => node.children ? [node, ...folders(node.children)] : [])
}

function imageUrl(workspace: Workspace, file: string, url: string) {
  if (!url || /^[a-z][a-z\d+.-]*:|^\/|^#/i.test(url)) return /^https:/i.test(url) ? defaultUrlTransform(url) : ''
  try {
    const parts = file.split('/').slice(0, -1)
    for (const encoded of url.split(/[?#]/, 1)[0].split('/')) {
      const part = decodeURIComponent(encoded)
      if (part === '..') {
        if (!parts.length) return ''
        parts.pop()
      } else if (part && part !== '.') {
        if (/[\/\\]/.test(part)) return ''
        parts.push(part)
      }
    }
    return 'note-image://' + workspace.token + '/' + parts.map(encodeURIComponent).join('/')
  } catch {
    return ''
  }
}

function SidebarIcon({ kind }: { kind: 'search' | 'recent' | 'favorite' | 'folder' | 'note' | 'root' }) {
  const paths = {
    search: 'M13 13l4 4 M15 9.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Z',
    recent: 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z M10 6.5V10l2.5 1.5',
    favorite: 'm10 3 2.2 4.5 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5-3.6-3.5 5-.7Z',
    folder: 'm7.5 5 5 5-5 5',
    note: 'M5 3h7l3 3v11H5Z M12 3v4h3 M8 10h4 M8 13h4',
    root: 'M3 15.5v-11h5l2 2h7v9Z'
  }
  return <svg className="sidebar-icon" data-kind={kind} viewBox="0 0 20 20" fill="none"
    stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={paths[kind]} />
  </svg>
}

function Tree({ nodes, selected, choose, open, expanded, toggle, onItemMenu }: {
  nodes: Node[]; selected: string; choose(node: Node): void; open(file: string): void
  expanded: Set<string>; toggle(file: string): void
  onItemMenu(event: MouseEvent<HTMLButtonElement>, file: string): void
}) {
  return <ul className="tree">{nodes.map(node => <li key={node.path}>
    <button className={selected === node.path ? 'selected' : ''} title={node.path}
      aria-expanded={node.children ? expanded.has(node.path) : undefined}
      onContextMenu={event => onItemMenu(event, node.path)}
      onClick={() => {
        choose(node)
        if (node.children) toggle(node.path)
        else open(node.path)
      }}>
      <SidebarIcon kind={node.children ? 'folder' : 'note'} />
      <span className="tree-label">{node.children ? node.name : node.name.replace(/\.md$/i, '')}</span>
    </button>
    {node.children && expanded.has(node.path) && <Tree {...{ nodes: node.children, selected, choose, open, expanded, toggle, onItemMenu }} />}
  </li>)}</ul>
}

function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [selected, setSelected] = useState('')
  const [expanded, setExpanded] = useState(new Set<string>())
  const [tabs, setTabs] = useState<Tab[]>([])
  const tabsRef = useRef(tabs)
  const scope = useRef<Workspace | null>(null)
  const nextId = useRef(0)
  const saveTimers = useRef(new Map<number, { text: string; timer: number }>())
  const [active, setActive] = useState<number>()
  const [mode, setMode] = useState<Mode>('split')
  const sourceMode = mode === 'source'
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [outline, setOutline] = useState(false)
  const [sidebar, setSidebar] = useState(true)
  const [panel, setPanel] = useState<'search' | 'settings' | 'recent' | 'favorites'>()
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null)
  const [jump, setJump] = useState<{ line: number }>()
  const [recent, setRecent] = useState<string[]>([])
  const [favorites, setFavorites] = useState<string[]>([])
  const [dark, setDark] = useState(() => localStorage.getItem('theme') === 'dark')
  const preview = useRef<HTMLElement>(null)
  const documentScroll = useRef<HTMLDivElement>(null)
  const scrollPositions = useRef(new Map<number, number>())
  const [checkpointError, setCheckpointError] = useState('')
  const checkpointTimer = useRef<number | undefined>(undefined)
  const latestSession = useRef<{ ws: Workspace; session: Session } | null>(null)
  const [dialog, setDialog] = useState<Dialog>()
  const [itemMenu, setItemMenu] = useState<{ file: string; x: number; y: number; trigger: HTMLButtonElement }>()
  const menuElement = useRef<HTMLDivElement>(null)
  const [info, setInfo] = useState<{ id: number; title: string; tags: string }>()
  const [compare, setCompare] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const current = tabs.find(tab => tab.id === active)
  const directories = folders(workspace?.nodes ?? [])
  const selectedDir = directories.some(folder => folder.path === selected) ? selected : parent(selected)
  const showOutline = !!current && outline
  const totals = counts(withoutMetadata(current?.text ?? ''))

  useLayoutEffect(() => {
    if (active !== undefined && documentScroll.current) {
      documentScroll.current.scrollTop = scrollPositions.current.get(active) ?? 0
    }
  }, [active])

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    localStorage.setItem('theme', dark ? 'dark' : 'light')
  }, [dark])

  useLayoutEffect(() => {
    const element = menuElement.current
    if (!itemMenu || !element) return
    element.style.left = Math.max(4, Math.min(itemMenu.x, window.innerWidth - element.offsetWidth - 4)) + 'px'
    element.style.top = Math.max(4, Math.min(itemMenu.y, window.innerHeight - element.offsetHeight - 4)) + 'px'
    element.querySelector('button')?.focus({ preventScroll: true })
  }, [itemMenu])

  useEffect(() => {
    if (!itemMenu) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuElement.current?.contains(event.target)) setItemMenu(undefined)
    }
    const dismiss = () => setItemMenu(undefined)
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [itemMenu])

  function selectNote(file: string) {
    setSelected(file)
    setExpanded(items => {
      const next = new Set(items)
      for (let dir = parent(file); dir; dir = parent(dir)) next.add(dir)
      return next
    })
    setCompare(false)
    setJump(undefined)
    setRecent(items => [file, ...items.filter(item => item !== file)].slice(0, 30))
  }

  function update(change: (items: Tab[]) => Tab[]) {
    tabsRef.current = change(tabsRef.current)
    setTabs(tabsRef.current)
  }

  function patch(id: number, change: Partial<Tab>) {
    update(items => items.map(tab => tab.id === id ? { ...tab, ...change } : tab))
  }

  function report(cause: unknown) { setError(message(cause)) }

  async function exclusive(task: () => Promise<void>) {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError('')
    try { await task() } catch (cause) { report(cause) }
    finally { locked.current = false; setBusy(false) }
  }

  async function refresh(ws: Workspace) {
    const nodes = await window.notes.tree(ws.token)
    if (scope.current?.token !== ws.token) return
    scope.current = { ...ws, nodes }
    setWorkspace(scope.current)
  }

  async function reconcile(ws: Workspace) {
    if (locked.current) return
    await refresh(ws)
    for (const snapshot of tabsRef.current) {
      const disk = normalize(await window.notes.read(ws.token, snapshot.path))
      const tab = tabsRef.current.find(item => item.id === snapshot.id)
      if (scope.current?.token !== ws.token || locked.current || tab?.path !== snapshot.path ||
          tab.saving || tab.recovery || tab.disk?.hash !== snapshot.disk?.hash) continue
      const base = tab.recoveryBase !== undefined ? tab.recoveryBase : tab.disk?.hash ?? null
      if ((disk?.hash ?? null) === base && tab.recoveryBase === undefined) {
        if (tab.conflict !== undefined) patch(tab.id, { conflict: undefined })
      } else if (tab.recoveryBase !== undefined) {
        if (disk?.hash !== tab.conflict?.hash) patch(tab.id, { conflict: disk })
      } else if (dirty(tab)) {
        patch(tab.id, { conflict: disk })
      } else if (disk) {
        patch(tab.id, { disk, text: disk.content, conflict: undefined, error: undefined })
      } else {
        patch(tab.id, { conflict: null })
      }
    }
  }

  useEffect(() => {
    let timer: number | undefined
    const schedule = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (locked.current) return schedule()
        if (scope.current) void reconcile(scope.current).catch(report)
      }, 180)
    }
    const unsubscribe = window.notes.onChanged(change => {
      if (scope.current?.token !== change.token) return
      if (change.error) report(change.error)
      schedule()
    })
    window.addEventListener('focus', schedule)
    const guard = (event: BeforeUnloadEvent) => {
      if (locked.current || tabsRef.current.some(pending)) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', guard)
    void exclusive(async () => {
      const ws = await window.notes.resume()
      if (ws) await restore(ws)
    })
    return () => {
      window.clearTimeout(timer)
      unsubscribe()
      window.removeEventListener('focus', schedule)
      window.removeEventListener('beforeunload', guard)
    }
  }, [])

  async function restore(ws: Workspace) {
    const restored: Tab[] = []
    for (const item of ws.session?.tabs ?? []) {
      let disk: Disk | null = null
      try { disk = normalize(await window.notes.read(ws.token, item.path)) }
      catch (cause) { report(cause) }
      if (!disk && !item.draft) continue
      restored.push({
        id: ++nextId.current, path: item.path, disk, text: disk?.content ?? '',
        recovery: item.draft?.text === disk?.content ? undefined : item.draft
      })
    }
    const selectedTab = restored.find(tab => tab.path === ws.session?.active) ?? restored.at(-1)
    scope.current = ws
    setWorkspace(ws)
    update(() => restored)
    setActive(selectedTab?.id)
    setSelected(selectedTab?.path ?? '')
    setMode(ws.session?.mode === 'source' ? 'source' : 'split')
    const ancestors = new Set<string>()
    for (const tab of restored) {
      for (let dir = parent(tab.path); dir; dir = parent(dir)) ancestors.add(dir)
    }
    setExpanded(ancestors)
    setQuery('')
    setResults(null)
    setRecent(ws.session?.recent ?? restored.map(tab => tab.path))
    setFavorites(ws.session?.favorites ?? [])
  }

  async function checkpoint() {
    const latest = latestSession.current
    if (!latest || scope.current?.token !== latest.ws.token) return
    try {
      await window.notes.session(latest.ws.token, latest.session)
      if (scope.current?.token === latest.ws.token) setCheckpointError('')
    } catch (cause) {
      if (scope.current?.token === latest.ws.token) setCheckpointError('草稿检查点保存失败：' + message(cause))
    }
  }

  useEffect(() => {
    if (!workspace) return
    latestSession.current = { ws: workspace, session: {
      active: current?.path,
      mode,
      recent,
      favorites,
      tabs: tabs.map(tab => ({
        path: tab.path,
        draft: tab.recovery ?? (dirty(tab) || tab.recoveryBase !== undefined ? {
          text: tab.text, base: tab.recoveryBase !== undefined ? tab.recoveryBase : tab.disk?.hash ?? null
        } : undefined)
      }))
    } }
    if (checkpointTimer.current === undefined) {
      checkpointTimer.current = window.setTimeout(() => {
        checkpointTimer.current = undefined
        void checkpoint()
      }, 450)
    }
  }, [workspace, tabs, active, mode, recent, favorites])

  useEffect(() => {
    const needle = query.trim()
    if (!workspace || !needle || panel !== 'search') return
    let ignore = false
    const timer = window.setTimeout(() => {
      void window.notes.search(workspace.token, needle)
        .then(items => { if (!ignore) setResults(items) })
        .catch(cause => { if (!ignore) { setResults([]); report(cause) } })
    }, 220)
    return () => { ignore = true; window.clearTimeout(timer) }
  }, [workspace, query, panel])

  async function save(id: number, overwrite = false) {
    const ws = scope.current
    const tab = tabsRef.current.find(item => item.id === id)
    if (!ws || !tab || tab.saving || tab.recovery || locked.current) return
    if (tab.conflict !== undefined && !overwrite) return
    if (!dirty(tab) && !overwrite) return
    const base = overwrite ? tab.conflict?.hash : tab.disk?.hash
    patch(id, { saving: true, error: undefined })
    try {
      const result = await window.notes.save(ws.token, tab.path, tab.text, base ?? null, overwrite)
      if (result.conflict) patch(id, { saving: false, conflict: normalize(result.disk) })
      else {
        const disk = normalize(result.disk)!
        const latest = tabsRef.current.find(item => item.id === id)
        patch(id, { saving: false, disk, text: latest?.text === tab.text ? disk.content : latest?.text ?? tab.text,
          conflict: undefined, recoveryBase: undefined })
      }
    } catch (cause) {
      patch(id, { saving: false, error: message(cause) })
    }
  }

  useEffect(() => {
    const eligible = new Map((busy ? [] : tabs.filter(tab =>
      dirty(tab) && !tab.saving && !tab.recovery && tab.conflict === undefined && !tab.error
    )).map(tab => [tab.id, tab.text]))
    for (const [id, entry] of saveTimers.current) {
      if (eligible.get(id) === entry.text) continue
      window.clearTimeout(entry.timer)
      saveTimers.current.delete(id)
    }
    for (const [id, text] of eligible) {
      if (saveTimers.current.has(id)) continue
      const timer = window.setTimeout(() => {
        saveTimers.current.delete(id)
        void save(id)
      }, 800)
      saveTimers.current.set(id, { text, timer })
    }
  }, [tabs, busy])

  async function open(ws: Workspace, path: string) {
    const existing = tabsRef.current.find(tab => tab.path === path)
    if (existing) { setActive(existing.id); return }
    const disk = normalize(await window.notes.read(ws.token, path))
    if (!disk) throw new Error('笔记已移除，无法打开')
    const tab = { id: ++nextId.current, path, disk, text: disk.content }
    update(items => [...items, tab])
    setActive(tab.id)
  }

  function close(tab: Tab) {
    if (pending(tab)) return report('关闭前请保存笔记或处理冲突')
    const remaining = tabsRef.current.filter(item => item.id !== tab.id)
    scrollPositions.current.delete(tab.id)
    update(() => remaining)
    if (active === tab.id) setActive(remaining.at(-1)?.id)
  }

  function choose() {
    void exclusive(async () => {
      if (tabsRef.current.some(pending)) throw new Error('切换工作区前请保存笔记或处理冲突')
      await checkpoint()
      const ws = await window.notes.choose()
      if (!ws) return
      await restore(ws)
    })
  }

  function begin(action: Action, file = selected) {
    setError('')
    setDialog({ action, path: file, name: ['rename', 'move'].includes(action) ? name(file) : '',
      directory: action === 'note' || action === 'folder' ? selectedDir : parent(file) })
  }

  function openItemMenu(event: MouseEvent<HTMLButtonElement>, file: string) {
    event.preventDefault()
    if (busy || dialog || panel || info) return
    const trigger = event.currentTarget
    const rect = trigger.getBoundingClientRect()
    const fromKeyboard = event.clientX === 0 && event.clientY === 0
    setSelected(file)
    setItemMenu({ file, trigger, x: fromKeyboard ? rect.left : event.clientX, y: fromKeyboard ? rect.bottom : event.clientY })
  }

  function perform(form: Dialog) {
    void exclusive(async () => {
      const ws = scope.current!
      const { action, path, name: filename, directory } = form
      if (action === 'note' || action === 'folder') {
        const created = await window.notes.create(ws.token, directory, filename.trim(), action === 'folder')
        if (action === 'note') {
          await open(ws, created)
          selectNote(created)
        } else setSelected(created)
      } else {
        if (tabsRef.current.some(tab => under(path, tab.path) && pending(tab))) {
          throw new Error('请先保存该项目下的笔记或处理冲突')
        }
        if (action === 'trash') {
          await window.notes.trash(ws.token, path)
          const remaining = tabsRef.current.filter(tab => !under(path, tab.path))
          setRecent(items => items.filter(item => !under(path, item)))
          setFavorites(items => items.filter(item => !under(path, item)))
          update(() => remaining)
          if (!remaining.some(tab => tab.id === active)) setActive(remaining.at(-1)?.id)
          setSelected(directory)
        } else {
          const target = await window.notes.move(ws.token, path, directory, filename.trim())
          const remap = (item: string) => under(path, item) ? target + item.slice(path.length) : item
          setRecent(items => items.map(remap))
          setFavorites(items => items.map(remap))
          update(items => items.map(tab => under(path, tab.path) ? { ...tab, path: target + tab.path.slice(path.length) } : tab))
          setExpanded(items => new Set([...items].map(item => under(path, item) ? target + item.slice(path.length) : item)))
          setSelected(target)
        }
      }
      setExpanded(items => {
        const next = new Set(items)
        for (let dir = directory; dir; dir = parent(dir)) next.add(dir)
        return next
      })
      setDialog(undefined)
      await refresh(ws)
    }).then(() => { if (scope.current) void reconcile(scope.current).catch(report) })
  }

  function useDisk(tab: Tab) {
    const disk = tab.conflict
    if (disk === undefined) return
    if (disk) patch(tab.id, { disk, text: disk.content, conflict: undefined, recoveryBase: undefined, error: undefined })
    else {
      patch(tab.id, { disk: null, text: '', conflict: undefined, error: undefined })
      update(items => items.filter(other => other.id !== tab.id))
      setActive(tabsRef.current.at(-1)?.id)
    }
    setCompare(false)
  }

  async function recover(tab: Tab, restoreDraft: boolean) {
    await exclusive(async () => {
      const ws = scope.current
      if (!ws || !tab.recovery) return
      const disk = normalize(await window.notes.read(ws.token, tab.path))
      if (restoreDraft) {
        const unchanged = disk && disk.hash === tab.recovery.base
        patch(tab.id, { disk, text: tab.recovery.text, recovery: undefined,
          recoveryBase: unchanged ? undefined : tab.recovery.base, conflict: unchanged ? undefined : disk })
      } else if (disk) {
        patch(tab.id, { disk, text: disk.content, recovery: undefined })
      } else {
        const remaining = tabsRef.current.filter(item => item.id !== tab.id)
        update(() => remaining)
        setActive(remaining.at(-1)?.id)
      }
      setCompare(false)
    })
  }

  function editInfo(tab: Tab) {
    void exclusive(async () => {
      const data = await window.notes.info(scope.current!.token, tab.text)
      setInfo({ id: tab.id, title: data.title, tags: data.tags.join('\n') })
    })
  }

  function applyInfo(form: NonNullable<typeof info>) {
    void exclusive(async () => {
      const tab = tabsRef.current.find(item => item.id === form.id)
      if (!tab) throw new Error('笔记已关闭')
      const tags = [...new Set(form.tags.split('\n').map(tag => tag.trim()).filter(Boolean))]
      const text = await window.notes.updateInfo(scope.current!.token, tab.text, form.title.trim(), tags)
      patch(tab.id, { text, error: undefined })
      setInfo(undefined)
    })
  }

  function openSearch() {
    setQuery('')
    setResults(null)
    setPanel('search')
  }

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f' && workspace) {
        event.preventDefault()
        openSearch()
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [workspace])

  function openFromPanel(file: string) {
    void exclusive(async () => {
      if (!workspace) return
      await open(workspace, file)
      selectNote(file)
      setPanel(undefined)
    })
  }

  return <div className={sidebar ? 'shell' : 'shell sidebar-hidden'}>
    <header className="top">
      <button className="icon" aria-label="导航栏" aria-pressed={sidebar} title="导航栏" onClick={() => setSidebar(!sidebar)}>☰</button>
      <strong className="brand"><span className="logo" aria-hidden="true">M</span>Markdown Studio</strong>
      <button className="workspace-switch" title="切换工作区" disabled={busy} onClick={choose}>{workspace?.name ?? '打开工作区'} ⌄</button>
      <div className="spacer" />
      <button className="icon" aria-label="切换主题" title="切换主题" aria-pressed={dark} onClick={() => setDark(!dark)}>◐</button>
      <button className="icon" aria-label="设置" title="设置" onClick={() => setPanel('settings')}>⚙</button>
      <button className="primary" disabled={busy || !workspace} onClick={() => begin('note')}>＋ 新建笔记</button>
    </header>
    <aside className="sidebar" aria-label="工作区" hidden={!sidebar}>
      <div className="side-scroll">
        <button className="nav side-nav" disabled={!workspace} onClick={openSearch}><SidebarIcon kind="search" />搜索</button>
        <button className="nav side-nav" disabled={!workspace} onClick={() => setPanel('recent')}><SidebarIcon kind="recent" />最近</button>
        <button className="nav side-nav" disabled={!workspace} onClick={() => setPanel('favorites')}><SidebarIcon kind="favorite" />收藏</button>
        <div className="section-name">我的笔记
          <button title="新建文件夹" aria-label="新建文件夹" disabled={!workspace || busy} onClick={() => begin('folder')}>＋</button>
        </div>
      {workspace && <>
        <button className={selected === '' ? 'nav tree-root selected' : 'nav tree-root'} title={workspace.name}
          onClick={() => setSelected('')}>
          <SidebarIcon kind="root" />
          <span className="tree-label">{workspace.name}</span>
        </button>
        <Tree nodes={workspace.nodes} selected={selected} choose={node => setSelected(node.path)} onItemMenu={openItemMenu}
          open={file => void exclusive(async () => { await open(workspace, file); selectNote(file) })} expanded={expanded} toggle={file => {
            setExpanded(items => {
              const next = new Set(items)
              if (next.has(file)) next.delete(file)
              else next.add(file)
              return next
            })
          }} />
      </>}
      </div>
      <div className="side-foot">●　{workspace ? '本地工作空间' : '尚未打开工作区'}</div>
    </aside>
    <main>
      <nav className="tabs" aria-label="打开的笔记">{tabs.map(tab => <div key={tab.id} className={tab.id === active ? 'tab active' : 'tab'}>
        <button title={tab.path + ' · ' + tabStatus(tab)} aria-current={tab.id === active ? 'page' : undefined}
          aria-label={name(tab.path) + '，' + tabStatus(tab)} onClick={() => { setActive(tab.id); selectNote(tab.path) }}>
          <span aria-hidden="true">▤</span><span className="tab-name">{displayTitle(tab)}</span>
          {pending(tab) && <span className={tab.error || tab.conflict !== undefined ? 'tab-mark tab-error' : 'tab-mark'}>
            {tab.error || tab.conflict !== undefined ? '!' : '●'}
          </span>}
        </button>
        <button className="tab-close" aria-label={'关闭 ' + name(tab.path)} onClick={() => close(tab)}>×</button>
      </div>)}</nav>
      {error && <div className="error" role="alert">{error}<button onClick={() => setError('')}>关闭</button></div>}
      {checkpointError && <div className="error" role="alert">{checkpointError}<button onClick={() => void checkpoint()}>重试</button></div>}
      {current && workspace ? <>
        <div className="document-bar">
          <div ref={setToolbar} className="format-slot" inert={busy || !!current.recovery || !!dialog || !!info || !!panel} />
          <div className="spacer" />
          <button className="mode-toggle" aria-label="查看源码" aria-pressed={sourceMode}
            title={sourceMode ? '切换到预览' : '切换到源码'}
            onClick={() => setMode(current => current === 'source' ? 'split' : 'source')}>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor"
              strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={sourceMode
                ? 'M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z M12 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z'
                : 'm6 6-4 4 4 4 M14 6l4 4-4 4 M12 4l-4 12'} />
            </svg>
          </button>
          <button aria-label="文档目录" title="文档目录" aria-pressed={outline} onClick={() => setOutline(!outline)}>☷</button>
          <button aria-label="文档信息" title="文档信息" disabled={busy || !!current.recovery} onClick={() => editInfo(current)}>ⓘ</button>
        </div>
        {current.recovery && <section className="conflict" role="alert">
          <strong>找到上次未保存的草稿</strong>
          <button onClick={() => setCompare(!compare)}>{compare ? '收起比较' : '查看草稿和磁盘版本'}</button>
          <button disabled={busy} onClick={() => void recover(current, true)}>恢复到编辑器</button>
          <button disabled={busy} onClick={() => void recover(current, false)}>放弃草稿</button>
        </section>}
        {current.conflict !== undefined && <section className="conflict" role="alert">
          <strong>{current.conflict ? '磁盘版本已更改' : '磁盘上的笔记已移动或移除'}</strong>
          <button onClick={() => setCompare(!compare)}>{compare ? '收起比较' : '比较两个版本'}</button>
          <button disabled={busy || current.saving} onClick={() => useDisk(current)}>{current.conflict
            ? dirty(current) ? '放弃草稿，使用磁盘版本' : '使用磁盘版本'
            : dirty(current) ? '放弃草稿并关闭' : '关闭笔记'}</button>
          <button disabled={busy || current.saving} onClick={() => void save(current.id, true)}>{current.conflict ? '备份磁盘版本并保存草稿' : '重新创建文件'}</button>
        </section>}
        {compare && (current.conflict !== undefined || current.recovery) && <div className="comparison">
          <div><strong>磁盘版本</strong><pre>{(current.recovery ? current.disk : current.conflict)?.content ?? '文件不存在'}</pre></div>
          <div><strong>草稿</strong><pre>{current.recovery?.text ?? current.text}</pre></div>
        </div>}
        <div className="work" inert={busy || !!dialog || !!info || !!panel || !!current.recovery}>
        <div ref={documentScroll} className={'panes ' + (mode === 'split' ? 'live' : mode)}
          onScroll={event => scrollPositions.current.set(current.id, event.currentTarget.scrollTop)}>
          <div className="document-heading">
            <div className="document-path" title={current.path}>{parent(current.path).split('/').join(' / ') || workspace.name}　·　本地笔记</div>
            <div className="document-title">
              {displayTitle(current)}
              <button className="icon" aria-label="收藏当前笔记" aria-pressed={favorites.includes(current.path)}
                onClick={() => setFavorites(items => items.includes(current.path) ? items.filter(item => item !== current.path) : [...items, current.path])}>
                {favorites.includes(current.path) ? '★' : '☆'}
              </button>
            </div>
          </div>
          {tabs.map(tab => <Editor key={tab.id} visible={tab.id === current.id}
            live={mode === 'split'} toolbar={toolbar} jump={tab.id === current.id ? jump : undefined}
            text={tab.text} onEdit={text => patch(tab.id, { text, error: undefined })}
            onSave={() => void save(tab.id)}
            onPaste={() => window.notes.paste(workspace.token, tab.path)} onError={report} />)}
          {showOutline && <article ref={preview} className="preview" hidden aria-label="Markdown 预览">
            <Markdown remarkPlugins={[remarkGfm]} skipHtml components={headingComponents}
              urlTransform={(url, key) => key === 'src' ? imageUrl(workspace, current.path, url) : defaultUrlTransform(url)}>
              {withoutMetadata(current.text)}
            </Markdown>
          </article>}
        </div>
        {showOutline && <Outline key={current.id} tab={current} preview={preview}
          onJump={line => { setJump({ line }); if (window.innerWidth <= 800) setOutline(false) }}
          onClose={() => setOutline(false)} />}
        </div>
        <footer>
          <span role="status">{tabStatus(current) === '已保存' ? '✓ ' : ''}{tabStatus(current)}{current.error ? ' · ' + current.error : ''}</span>
          <span>{totals.words} 字</span><span>{totals.chars} 字符</span><div className="spacer" />
          <span>Markdown</span><span>UTF-8</span>
          <button disabled={busy || current.saving || !!current.recovery || current.conflict !== undefined || !dirty(current)} onClick={() => void save(current.id)}>保存</button>
        </footer>
      </> : <div className="empty">
        <h1>{workspace ? '打开一篇笔记' : '打开本地笔记文件夹'}</h1>
        <button disabled={busy} onClick={workspace ? () => begin('note') : choose}>{workspace ? '新建笔记' : '选择文件夹'}</button>
      </div>}
    </main>
    {itemMenu && <div className="item-menu" ref={menuElement} role="menu" aria-label="文件操作" onKeyDown={event => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault()
        setItemMenu(undefined)
        itemMenu.trigger.focus({ preventScroll: true })
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const entries = Array.from(event.currentTarget.querySelectorAll('button'))
        const index = entries.indexOf(document.activeElement as HTMLButtonElement)
        const step = event.key === 'ArrowDown' ? 1 : -1
        entries[(index + step + entries.length) % entries.length]?.focus()
      }
    }}>
      {itemActions.map(action => <button key={action} role="menuitem" tabIndex={-1} disabled={busy} onClick={() => {
        setItemMenu(undefined)
        begin(action, itemMenu.file)
      }}>{labels[action]}</button>)}
    </div>}
    {panel && <div className="overlay" onKeyDown={event => { if (event.key === 'Escape') setPanel(undefined) }}>
      <section className="dialog-panel" role="dialog" aria-modal="true" aria-label="工作区面板">
        <div className="dialog-heading">
          <strong>{{ search: '搜索笔记', settings: '设置', recent: '最近打开', favorites: '收藏' }[panel]}</strong>
          <button aria-label="关闭面板" onClick={() => setPanel(undefined)}>×</button>
        </div>
        <div className="dialog-content">
          {panel === 'search' ? <>
            <input autoFocus type="search" aria-label="搜索笔记" placeholder="搜索标题或正文…"
              value={query} onChange={event => { setQuery(event.target.value); setResults(null) }} />
            {query.trim() && <div className="results" aria-live="polite">
              {results === null ? <p>正在搜索…</p> : results.length === 0 ? <p>没有匹配的笔记</p> : results.map(result =>
                <button key={result.path} title={result.path} onClick={() => openFromPanel(result.path)}>
                  <strong>{result.title}</strong><small>{result.path} · {result.excerpt}</small>
                </button>)}
            </div>}
          </> : panel === 'settings' ? <>
            <div className="stat"><span>主题</span><button autoFocus onClick={() => setDark(!dark)}>{dark ? '深色' : '浅色'}</button></div>
            <div className="stat"><span>自动保存</span><span>开启 · 800ms</span></div>
            <div className="stat"><span>正文存储</span><span>Markdown 文件</span></div>
            <div className="stat"><span>索引</span><span>SQLite</span></div>
          </> : <div className="results">
            {(panel === 'recent' ? recent : favorites).length === 0 && <p>暂无记录</p>}
            {(panel === 'recent' ? recent : favorites).map(file =>
              <button key={file} title={file} onClick={() => openFromPanel(file)}>{file}</button>)}
          </div>}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      </section>
    </div>}
    {info && <div className="overlay" onKeyDown={event => { if (event.key === 'Escape' && !busy) setInfo(undefined) }}>
      <form role="dialog" aria-modal="true" aria-label="文档信息" onSubmit={event => { event.preventDefault(); applyInfo(info) }}>
        <h2>文档信息</h2>
        <label>标题<input autoFocus disabled={busy} value={info.title}
          onChange={event => setInfo({ ...info, title: event.target.value })} /></label>
        <label>标签，每行一个<textarea rows={4} disabled={busy} value={info.tags}
          onChange={event => setInfo({ ...info, tags: event.target.value })} /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="dialog-buttons">
          <button type="button" disabled={busy} onClick={() => { setInfo(undefined); setError('') }}>取消</button>
          <button className="primary" disabled={busy}>应用</button>
        </div>
      </form>
    </div>}
    {dialog && <div className="overlay" onKeyDown={event => { if (event.key === 'Escape' && !busy) setDialog(undefined) }}>
      <form role="dialog" aria-modal="true" aria-label={labels[dialog.action]} onSubmit={event => { event.preventDefault(); perform(dialog) }}>
        <h2>{labels[dialog.action]}</h2>
        {dialog.action === 'trash' ? <p>将「{dialog.path}」移至系统废纸篓？</p> : <>
          {dialog.action !== 'move' && <label>名称<input autoFocus required disabled={busy} value={dialog.name}
            onChange={event => setDialog({ ...dialog, name: event.target.value })} /></label>}
          {dialog.action !== 'rename' && <label>目标目录<select autoFocus={dialog.action === 'move'} disabled={busy}
            value={dialog.directory} onChange={event => setDialog({ ...dialog, directory: event.target.value })}>
            <option value="">根目录</option>
            {directories.filter(folder => dialog.action !== 'move' || !under(dialog.path, folder.path))
              .map(folder => <option key={folder.path} value={folder.path}>{folder.path}</option>)}
          </select></label>}
        </>}
        {error && <p role="alert" className="error">{error}</p>}
        <div className="dialog-buttons">
          <button type="button" disabled={busy} onClick={() => { setDialog(undefined); setError('') }}>取消</button>
          <button className="primary" disabled={busy}>{labels[dialog.action]}</button>
        </div>
      </form>
    </div>}
  </div>
}

createRoot(document.getElementById('root')!).render(<App />)
