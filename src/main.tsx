import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react'
import { createRoot } from 'react-dom/client'
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Editor } from './Editor'
import { frontmatterPattern } from './markdown-preview'
import type { Disk, Draft, Jump, Mode, Node, SearchField, SearchResult, Session, TrashPreview, Workspace, WorkspaceIssue } from './types'
import './style.css'

type Tab = { id: number; path: string; text: string; disk: Disk | null; conflict?: Disk | null; movedTo?: string; recovery?: Draft; recovered?: Draft; checkedAt?: string; saving?: boolean; error?: string }
type Action = 'note' | 'folder' | 'rename' | 'move' | 'trash'
const itemActions = ['rename', 'move', 'trash'] as const
type Dialog = { action: Action; path: string; name: string; directory: string; trash?: TrashPreview }
const labels = { note: '新建笔记', folder: '新建文件夹', rename: '重命名', move: '移动', trash: '移至废纸篓' }
const dirty = (tab: Tab) => tab.text !== (tab.disk?.content ?? '')
const pending = (tab: Tab) => dirty(tab) || tab.saving || tab.conflict !== undefined || !!tab.recovery
const under = (base: string, file: string) => file === base || file.startsWith(base + '/')
const name = (file: string) => file.split('/').at(-1) ?? ''
const parent = (file: string) => file.split('/').slice(0, -1).join('/')
const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error)
const normalize = (disk: Disk | null) => disk && { ...disk, content: disk.content.replace(/\r\n?/g, '\n') }
const withoutMetadata = (text: string) => text.replace(frontmatterPattern, '')
const searchLabels: Record<SearchField, string> = { title: '标题', path: '路径', body: '正文' }
const issueLabels = { read: '无法读取', index: '索引异常', yaml: 'Frontmatter 异常', link: '失效引用', asset: '疑似孤立附件', draft: '草稿' }
function findSearchJump(text: string, needle: string): Jump {
  const body = withoutMetadata(text)
  const firstLine = text.slice(0, text.length - body.length).split('\n').length
  const hit = body.split('\n').findIndex(line => line.toLowerCase().includes(needle))
  return hit >= 0 ? { line: firstLine + hit, match: needle } : { line: Math.min(firstLine, text.split('\n').length) }
}
const draftFor = (tab: Tab): Draft | undefined => tab.recovery ?? (dirty(tab) || tab.recovered ? {
  text: tab.text,
  base: tab.recovered ? tab.recovered.base : tab.disk?.hash ?? null,
  baseline: tab.recovered ? tab.recovered.baseline : tab.disk?.content ?? null,
  identity: tab.recovered ? tab.recovered.identity : tab.disk?.identity,
  checkedAt: tab.checkedAt ?? tab.recovered?.checkedAt
} : undefined)

function changedLines(base: string, text: string) {
  const before = base.split('\n')
  const after = text.split('\n')
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > prefix && endAfter > prefix && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--
    endAfter--
  }
  const added = new Set<number>()
  const removed = new Set<number>()
  const rows = endBefore - prefix
  const columns = endAfter - prefix
  if ((rows + 1) * (columns + 1) > 250_000) {
    for (let i = prefix; i < endBefore; i++) removed.add(i)
    for (let i = prefix; i < endAfter; i++) added.add(i)
    return { added, removed }
  }
  const lengths = Array.from({ length: rows + 1 }, () => new Uint32Array(columns + 1))
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = columns - 1; j >= 0; j--) {
      lengths[i][j] = before[prefix + i] === after[prefix + j] ? 1 + lengths[i + 1][j + 1]
        : Math.max(lengths[i + 1][j], lengths[i][j + 1])
    }
  }
  let i = 0
  let j = 0
  while (i < rows || j < columns) {
    if (i < rows && j < columns && before[prefix + i] === after[prefix + j]) { i++; j++ }
    else if (i < rows && (j === columns || lengths[i + 1][j] >= lengths[i][j + 1])) removed.add(prefix + i++)
    else added.add(prefix + j++)
  }
  return { added, removed }
}

function DraftComparison({ draft, disk }: { draft: Draft; disk: Disk | null }) {
  const base = draft.baseline
  const draftChanges = base == null ? undefined : changedLines(base, draft.text)
  const diskChanges = base == null ? undefined : changedLines(base, disk?.content ?? '')
  const pane = (title: string, text: string | null | undefined, placeholder: string, changes?: Set<number>) =>
    <div><strong>{title}</strong><pre>{text == null ? placeholder : text.split('\n').map((line, index) =>
      <span key={index} className={changes?.has(index) ? 'changed-line' : undefined}>{line || ' '}</span>)}</pre></div>
  return <div className="comparison draft-comparison">
    {pane('保存基线', base, base === undefined ? '历史草稿未记录基线正文' : '基线文件不存在',
      new Set([...(draftChanges?.removed ?? []), ...(diskChanges?.removed ?? [])]))}
    {pane('草稿', draft.text, '', draftChanges?.added)}
    {pane('当前磁盘版本', disk?.content, '文件不存在', diskChanges?.added)}
  </div>
}

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

function relativeTarget(file: string, url: string) {
  if (!url || /^[a-z][a-z\d+.-]*:|^[\/\\#]/i.test(url)) return null
  try {
    const parts = file.split('/').slice(0, -1)
    for (const encoded of url.split(/[?#]/, 1)[0].split('/')) {
      const part = decodeURIComponent(encoded)
      if (part === '..') {
        if (!parts.length) return null
        parts.pop()
      } else if (part && part !== '.') {
        if (/[\/\\:\0]/.test(part)) return null
        parts.push(part)
      }
    }
    return parts.join('/')
  } catch {
    return null
  }
}

function imageUrl(workspace: Workspace, file: string, url: string) {
  if (/^https:/i.test(url)) return defaultUrlTransform(url)
  const target = relativeTarget(file, url)
  return target ? 'note-image://' + workspace.token + '/' + target.split('/').map(encodeURIComponent).join('/') : ''
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
      {node.attachment && node.path === 'Attachments' && <small className="attachment-label">附件</small>}
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
  const [panel, setPanel] = useState<'search' | 'settings' | 'recent' | 'favorites' | 'drafts' | 'checks'>()
  const [maintenance, setMaintenance] = useState<'rebuild' | 'check'>()
  const maintenanceRef = useRef(false)
  const [rebuilt, setRebuilt] = useState('')
  const [issues, setIssues] = useState<WorkspaceIssue[]>()
  const [draftPreview, setDraftPreview] = useState<{ id: number; disk: Disk | null }>()
  const [draftDisks, setDraftDisks] = useState<Map<string, string | null | undefined>>()
  const [checkpointTimes, setCheckpointTimes] = useState(new Map<string, string>())
  const [discard, setDiscard] = useState<number>()
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null)
  const [jump, setJump] = useState<Jump>()
  const waitingSearch = useRef(new Map<number, string>())
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
  const currentDraft = current && draftFor(current)
  const trashBlocked = dialog?.action === 'trash' ? tabs.filter(tab => under(dialog.path, tab.path) && pending(tab)) : []
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
          tab.saving || tab.disk?.hash !== snapshot.disk?.hash) continue
      if (tab.recovery) {
        if (disk?.hash !== tab.disk?.hash) patch(tab.id, { disk })
        continue
      }
      const base = tab.recovered ? tab.recovered.base : tab.disk?.hash ?? null
      if ((disk?.hash ?? null) === base && !tab.recovered && disk) {
        if (tab.conflict !== undefined) patch(tab.id, { conflict: undefined, movedTo: undefined })
      } else if (tab.recovered && disk) {
        if (disk.hash !== tab.conflict?.hash || tab.movedTo) patch(tab.id, { conflict: disk, movedTo: undefined })
      } else if (disk && dirty(tab)) {
        patch(tab.id, { conflict: disk, movedTo: undefined })
      } else if (disk) {
        patch(tab.id, { disk, text: disk.content, conflict: undefined, movedTo: undefined, error: undefined })
      } else {
        patch(tab.id, { conflict: null })
        const identity = tab.recovered?.identity ?? tab.disk?.identity
        if (identity && base) {
          const candidate = await window.notes.movedNote(ws.token, tab.path, identity, base)
          if (scope.current?.token === ws.token && !locked.current &&
              tabsRef.current.some(item => item.id === tab.id && item.path === tab.path && item.conflict === null)) {
            patch(tab.id, { movedTo: candidate ?? undefined })
          }
        }
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
    waitingSearch.current.clear()
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
    setCheckpointTimes(new Map((ws.session?.tabs ?? []).flatMap(item =>
      item.draft?.checkedAt ? [[item.path, item.draft.checkedAt] as const] : [])))
    setQuery('')
    setResults(null)
    setRebuilt('')
    setIssues(undefined)
    setPanel(undefined)
    setRecent(ws.session?.recent ?? restored.map(tab => tab.path))
    setFavorites(ws.session?.favorites ?? [])
  }

  async function checkpoint() {
    const latest = latestSession.current
    if (!latest || scope.current?.token !== latest.ws.token) return
    try {
      const times = await window.notes.session(latest.ws.token, latest.session)
      if (scope.current?.token === latest.ws.token) {
        setCheckpointTimes(new Map(times.map(item => [item.path, item.checkedAt])))
        setCheckpointError('')
      }
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
      tabs: tabs.map(tab => ({ path: tab.path, draft: draftFor(tab) }))
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
      if (result.conflict) {
        patch(id, { saving: false, conflict: normalize(result.disk) })
        if (overwrite) report('磁盘版本再次变化，请核对后重试')
      }
      else {
        const disk = normalize(result.disk)!
        const latest = tabsRef.current.find(item => item.id === id)
        patch(id, { saving: false, disk, text: latest?.text === tab.text ? disk.content : latest?.text ?? tab.text,
          conflict: undefined, recovered: undefined })
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

  async function open(ws: Workspace, path: string): Promise<Tab> {
    const existing = tabsRef.current.find(tab => tab.path === path)
    if (existing) { setActive(existing.id); return existing }
    const disk = normalize(await window.notes.read(ws.token, path))
    if (!disk) throw new Error('笔记已移除，无法打开')
    const tab = { id: ++nextId.current, path, disk, text: disk.content }
    update(items => [...items, tab])
    setActive(tab.id)
    return tab
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
    const next = { action, path: file, name: ['rename', 'move'].includes(action) ? name(file) : '',
      directory: action === 'note' || action === 'folder' ? selectedDir : parent(file) }
    setDialog(next)
    if (action === 'trash') void exclusive(async () => {
      const trash = await window.notes.trashPreview(scope.current!.token, file)
      setDialog(value => value === next ? { ...next, trash } : value)
    })
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
        if (action === 'trash') {
          if (!form.trash) return
          const blocked = tabsRef.current.filter(tab => under(path, tab.path) && pending(tab))
          if (blocked.length) throw new Error('请先保存笔记或处理冲突：' + blocked.map(tab => tab.path).join('、'))
          const updated = await window.notes.trash(ws.token, path, form.trash.signature)
          if (updated) {
            setDialog({ ...form, trash: updated })
            throw new Error('内容范围已变化，请核对后再次确认')
          }
          const remaining = tabsRef.current.filter(tab => !under(path, tab.path))
          setRecent(items => items.filter(item => !under(path, item)))
          setFavorites(items => items.filter(item => !under(path, item)))
          update(() => remaining)
          if (!remaining.some(tab => tab.id === active)) setActive(remaining.at(-1)?.id)
          setSelected(directory)
        } else {
          const blocked = tabsRef.current.filter(pending).map(tab => ({ path: tab.path, text: draftFor(tab)?.text ?? tab.text }))
          const target = await window.notes.move(ws.token, path, directory, filename.trim(), blocked)
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
    if (disk) patch(tab.id, { disk, text: disk.content, conflict: undefined, recovered: undefined, error: undefined })
    else {
      patch(tab.id, { disk: null, text: '', conflict: undefined, error: undefined })
      update(items => items.filter(other => other.id !== tab.id))
      setActive(tabsRef.current.at(-1)?.id)
    }
    setCompare(false)
  }

  function relink(tab: Tab) {
    void exclusive(async () => {
      const ws = scope.current
      const identity = tab.recovered?.identity ?? tab.disk?.identity
      const hash = tab.recovered?.base ?? tab.disk?.hash
      if (!ws || !identity || !hash) return
      const target = await window.notes.movedNote(ws.token, tab.path, identity, hash)
      if (!target || target !== tab.movedTo) throw new Error('移动目标已变化，请重新检查')
      if (tabsRef.current.some(other => other.path === target)) throw new Error('请先关闭目标笔记的标签')
      const disk = normalize(await window.notes.read(ws.token, target))
      if (!disk || disk.hash !== hash || disk.identity !== identity) throw new Error('移动目标已变化，请重新检查')
      patch(tab.id, { path: target, disk, conflict: undefined, recovered: undefined, movedTo: undefined, error: undefined })
      setFavorites(items => [...new Set(items.map(item => item === tab.path ? target : item))])
      setRecent(items => items.filter(item => item !== tab.path))
      selectNote(target)
    })
  }

  async function recover(tab: Tab, restoreDraft: boolean) {
    await exclusive(async () => {
      const ws = scope.current
      const draft = draftFor(tab)
      if (!ws || !draft || tab.saving) return
      const disk = normalize(await window.notes.read(ws.token, tab.path))
      if (restoreDraft) {
        const unchanged = disk && disk.hash === draft.base
        const movedTo = !disk && draft.identity && draft.base
          ? await window.notes.movedNote(ws.token, tab.path, draft.identity, draft.base) : undefined
        patch(tab.id, { disk, text: draft.text, recovery: undefined, checkedAt: draft.checkedAt,
          recovered: unchanged ? undefined : draft, conflict: unchanged ? undefined : disk, movedTo: movedTo ?? undefined, error: undefined })
        setActive(tab.id)
        selectNote(tab.path)
        const needle = waitingSearch.current.get(tab.id)
        if (needle) setJump(findSearchJump(draft.text, needle))
        setPanel(undefined)
      } else if (disk) {
        patch(tab.id, { disk, text: disk.content, recovery: undefined, recovered: undefined, conflict: undefined, error: undefined })
      } else {
        const remaining = tabsRef.current.filter(item => item.id !== tab.id)
        update(() => remaining)
        if (tab.id === active) setActive(remaining.at(-1)?.id)
      }
      waitingSearch.current.delete(tab.id)
      setDiscard(undefined)
      setDraftPreview(undefined)
      setCompare(false)
    })
  }

  function previewDraft(tab: Tab, compareInEditor = false) {
    void exclusive(async () => {
      const ws = scope.current
      if (!ws) return
      const disk = normalize(await window.notes.read(ws.token, tab.path))
      if (compareInEditor) {
        if (tab.recovery) patch(tab.id, { disk })
        setCompare(true)
      } else {
        setDraftPreview({ id: tab.id, disk })
        setDiscard(undefined)
      }
    })
  }

  async function openDrafts() {
    setDraftPreview(undefined)
    setDiscard(undefined)
    setError('')
    setDraftDisks(undefined)
    setPanel('drafts')
    const ws = scope.current
    if (!ws) return
    const statuses = await Promise.all(tabsRef.current.filter(draftFor).map(async tab => {
      try {
        const disk = await window.notes.read(ws.token, tab.path)
        return [tab.path, disk?.hash ?? null] as const
      } catch {
        return [tab.path, undefined] as const
      }
    }))
    if (scope.current?.token === ws.token) setDraftDisks(new Map(statuses))
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
      const ws = scope.current!
      const tags = [...new Set(form.tags.split('\n').map(tag => tag.trim()).filter(Boolean))]
      const raw = !pending(tab) && tab.disk ? await window.notes.read(ws.token, tab.path) : null
      if (!pending(tab) && tab.disk && raw?.hash !== tab.disk.hash) {
        throw new Error('磁盘版本已变化，请关闭对话框后核对当前文件')
      }
      const text = await window.notes.updateInfo(ws.token, raw?.content ?? tab.text, form.title.trim(), tags)
      const normalized = text.replace(/\r\n?/g, '\n')
      if (raw && text !== raw.content) {
        const result = await window.notes.save(ws.token, tab.path, text, raw.hash, false, true)
        if (result.conflict) {
          patch(tab.id, { text: normalized, conflict: normalize(result.disk) })
          throw new Error('磁盘版本已变化，编辑内容保留在草稿中')
        }
        const disk = normalize(result.disk)!
        patch(tab.id, { text: disk.content, disk, error: undefined })
      } else patch(tab.id, { text: normalized, error: undefined })
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
      const command = /Mac/i.test(navigator.platform) ? event.metaKey : event.ctrlKey
      if (!command || event.altKey || event.isComposing || event.keyCode === 229 || !workspace ||
          locked.current || panel || dialog || info || itemMenu) return
      const key = event.key.toLowerCase()
      if (event.shiftKey && key === 'f') { event.preventDefault(); openSearch(); return }
      if (event.shiftKey || event.repeat) return
      if (key === 'n') { event.preventDefault(); begin('note') }
      if (key === 'w' && current) { event.preventDefault(); close(current) }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [workspace, current, selected, selectedDir, panel, dialog, info, itemMenu])

  function openFromPanel(file: string, search?: SearchResult) {
    void exclusive(async () => {
      if (!workspace) return
      const tab = await open(workspace, file)
      selectNote(file)
      setPanel(undefined)
      if (!search) return
      const needle = query.trim().toLowerCase()
      const disk = pending(tab) ? null : normalize(await window.notes.read(workspace.token, file))
      const latest = tab.recovery?.text ?? disk?.content ?? tab.text
      if (disk && disk.hash !== tab.disk?.hash) patch(tab.id, { text: disk.content, disk })
      if (tab.recovery) { waitingSearch.current.set(tab.id, needle); return }
      const destination = findSearchJump(latest, needle)
      setJump(destination)
      if (!destination.match) {
        scrollPositions.current.set(tab.id, 0)
        if (documentScroll.current) documentScroll.current.scrollTop = 0
      }
    })
  }

  async function runMaintenance(action: 'rebuild' | 'check') {
    const ws = scope.current
    if (!ws || maintenanceRef.current) return
    maintenanceRef.current = true
    setMaintenance(action)
    setError('')
    try {
      if (action === 'rebuild') {
        setRebuilt('')
        const result = await window.notes.rebuildIndex(ws.token)
        if (scope.current?.token === ws.token) {
          setRebuilt('索引重建完成，共 ' + result.total + ' 篇笔记' + (result.backup ? '。旧索引备份：' + result.backup : ''))
        }
      } else {
        setIssues(undefined)
        setPanel('checks')
        const drafts = tabsRef.current.filter(draftFor).map(tab => tab.path)
        const report = await window.notes.checkWorkspace(ws.token, drafts)
        if (scope.current?.token === ws.token) setIssues(report)
      }
    } catch (cause) { if (scope.current?.token === ws.token) report(cause) }
    finally { maintenanceRef.current = false; setMaintenance(undefined) }
  }

  function openNoteLink(ws: Workspace, file: string, url: string) {
    void exclusive(async () => {
      if (/^(https?:|mailto:)/i.test(url)) {
        await window.notes.openExternal(ws.token, url)
        return
      }
      const hash = url.indexOf('#')
      const rawAnchor = hash === -1 ? '' : url.slice(hash + 1)
      const anchor = decodeURIComponent(rawAnchor)
      const target = url.startsWith('#') ? file : relativeTarget(file, url)
      if (!target || !/\.md$/i.test(target)) throw new Error('链接必须指向工作区内的 Markdown 文件或网页')
      let line: number | undefined
      if (anchor) {
        const disk = tabsRef.current.find(tab => tab.path === target)
          ?? await window.notes.read(ws.token, target).then(result => result && { text: result.content })
        const slug = (heading: string) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, '').replace(/\s+/g, '-')
        const lines = disk?.text.split('\n') ?? []
        const index = lines.findIndex(text => {
          const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(text)
          return heading && (heading[1] === anchor || slug(heading[1]) === anchor)
        })
        if (index >= 0) line = index + 1
      }
      await open(ws, target)
      selectNote(target)
      if (line !== undefined) setJump({ line })
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
        <button className="nav side-nav" disabled={!workspace} onClick={() => void openDrafts()} title="恢复草稿" aria-label="恢复草稿"><SidebarIcon kind="note" />草稿</button>
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
          <button disabled={busy} onClick={() => compare ? setCompare(false) : previewDraft(current, true)}>{compare ? '收起比较' : '比较版本'}</button>
          <button disabled={busy} onClick={() => void recover(current, true)}>恢复到编辑器</button>
          <button disabled={busy} onClick={() => void openDrafts().then(() => setDiscard(current.id))}>放弃草稿</button>
        </section>}
        {current.conflict !== undefined && <section className="conflict" role="alert">
          <strong>{current.conflict ? '磁盘版本已更改' : '磁盘上的笔记已移动或移除'}</strong>
          {currentDraft && <button onClick={() => setCompare(!compare)}>{compare ? '收起比较' : '比较版本'}</button>}
          <button disabled={busy || current.saving} onClick={() => useDisk(current)}>{current.conflict
            ? dirty(current) ? '放弃草稿，使用磁盘版本' : '使用磁盘版本'
            : dirty(current) ? '放弃草稿并关闭' : '关闭笔记'}</button>
          <button disabled={busy || current.saving} onClick={() => void save(current.id, true)}>{current.conflict ? '备份磁盘版本并保存草稿' : '重新创建文件'}</button>
          {current.movedTo && <button disabled={busy} onClick={() => relink(current)}>重新关联到 {current.movedTo}</button>}
          {current.conflict === null && !current.movedTo &&
            <button disabled={busy} onClick={openSearch}>搜索目标笔记</button>}
        </section>}
        {compare && (current.conflict !== undefined || current.recovery) && currentDraft &&
          <DraftComparison draft={currentDraft} disk={(current.recovery ? current.disk : current.conflict) ?? null} />}
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
            imageUrl={url => imageUrl(workspace, tab.path, url)}
            copyCode={code => window.notes.copyCode(workspace.token, code)}
            openLink={url => openNoteLink(workspace, tab.path, url)}
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
          <strong>{{ search: '搜索笔记', settings: '设置', recent: '最近打开', favorites: '收藏', drafts: '恢复草稿', checks: '工作区检查' }[panel]}</strong>
          <button aria-label="关闭面板" onClick={() => setPanel(undefined)}>×</button>
        </div>
        <div className="dialog-content">
          {panel === 'search' ? <>
            <input autoFocus type="search" aria-label="搜索笔记" placeholder="搜索标题或正文…"
              value={query} onChange={event => { setQuery(event.target.value); setResults(null) }} />
            {query.trim() && <div className="results" aria-live="polite">
              {results === null ? <p>正在搜索…</p> : results.length === 0 ? <p>没有匹配的笔记</p> : results.map(result =>
                <button key={result.path} title={result.path} onClick={() => openFromPanel(result.path, result)}>
                  <strong>{result.title}</strong><small>{result.path} · 命中{result.fields.map(field => searchLabels[field]).join('、')}</small>
                  {result.excerpt && <small>{result.excerpt}</small>}
                </button>)}
            </div>}
          </> : panel === 'drafts' ? <div className="results draft-list">
            {!tabs.some(draftFor) && <p>当前工作区没有待处理的草稿</p>}
            {tabs.map(tab => {
              const draft = draftFor(tab)
              if (!draft) return null
              const hash = draftDisks?.get(tab.path)
              const diskStatus = !draftDisks ? '正在检查' : hash === undefined ? '磁盘状态未知'
                : hash === null ? '文件不存在' : hash === draft.base ? '磁盘未变化' : '磁盘已变化'
              const time = checkpointTimes.get(tab.path) ?? draft.checkedAt
              return <article key={tab.id}>
                <strong>{displayTitle({ ...tab, text: draft.text })}</strong>
                <small>{tab.path} · {diskStatus}</small>
                <small>{time ? '检查点 ' + new Date(time).toLocaleString() : '检查点时间不可用'}</small>
                <div className="draft-actions">
                  <button disabled={busy} onClick={() => previewDraft(tab)}>预览</button>
                  <button disabled={busy || tab.saving} onClick={() => void recover(tab, true)}>恢复到编辑器</button>
                  <button disabled={busy || tab.saving} onClick={() => setDiscard(tab.id)}>放弃草稿</button>
                </div>
                {discard === tab.id && <div className="draft-actions">
                  <span>放弃「{tab.path}」的草稿？</span>
                  <button onClick={() => setDiscard(undefined)}>取消</button>
                  <button disabled={busy || tab.saving} onClick={() => void recover(tab, false)}>确认放弃</button>
                </div>}
                {draftPreview?.id === tab.id && <DraftComparison draft={draft} disk={draftPreview.disk} />}
              </article>
            })}
          </div> : panel === 'settings' ? <>
            <div className="stat"><span>主题</span><button autoFocus onClick={() => setDark(!dark)}>{dark ? '深色' : '浅色'}</button></div>
            <div className="stat"><span>自动保存</span><span>开启 · 800ms</span></div>
            <div className="stat"><span>正文存储</span><span>Markdown 文件</span></div>
            <div className="stat"><span>索引</span><span>SQLite</span></div>
            <div className="stat"><button disabled={!workspace || !!maintenance} onClick={() => void runMaintenance('rebuild')}>重建搜索索引</button>
              <span role="status">{maintenance === 'rebuild' ? '正在重建…' : rebuilt}</span>
            </div>
            <div className="stat"><button disabled={!workspace || !!maintenance} onClick={() => void runMaintenance('check')}>工作区检查</button>
              {maintenance === 'check' && <span role="status">正在检查…</span>}
            </div>
          </> : panel === 'checks' ? <div className="results" aria-live="polite">
            {!issues && maintenance === 'check' && <p>正在检查… 关闭此面板可继续编辑。</p>}
            {issues?.length === 0 && <p>检查完成，未发现问题。</p>}
            {issues?.map((issue, index) => {
              const file = issue.path
              const summary = <><strong>{issueLabels[issue.kind]}</strong><small>{[file, issue.detail].filter(Boolean).join(' · ')}</small></>
              if (issue.kind === 'draft') return <button key={index} onClick={() => void openDrafts()}>{summary}</button>
              if (issue.kind === 'index') return <button key={index} onClick={() => setPanel('settings')}>{summary}</button>
              if (file && (issue.kind === 'yaml' || issue.kind === 'link')) return <button key={index} onClick={() => openFromPanel(file)}>{summary}</button>
              return <div className="check-result" key={index}>{summary}</div>
            })}
          </div> : <div className="results">
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
        {dialog.action === 'trash' ? <>
          <p>将「{dialog.path}」移至系统废纸篓？</p>
          {dialog.trash?.directory && <p>整个目录及其中 {dialog.trash.directories} 个子目录、{dialog.trash.files} 个文件都会移走，统计包含隐藏条目。</p>}
          {trashBlocked.length > 0 && <p role="alert">
            请先保存笔记或处理冲突：{trashBlocked.map(tab => tab.path).join('、')}
          </p>}
        </> : <>
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
          <button className="primary" disabled={busy || dialog.action === 'trash' &&
            (!dialog.trash || trashBlocked.length > 0)}>{labels[dialog.action]}</button>
        </div>
      </form>
    </div>}
  </div>
}

createRoot(document.getElementById('root')!).render(<App />)
