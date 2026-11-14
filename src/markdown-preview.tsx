import { useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import Markdown, { type Components } from 'react-markdown'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { EditorView, WidgetType } from '@codemirror/view'
import type { RootContent } from 'mdast'
import hljs from 'highlight.js/lib/common'
import 'katex/dist/katex.min.css'
import 'highlight.js/styles/github.css'

export const frontmatterPattern = /^(?:\uFEFF)?---[ \t]*\n(?:[\s\S]*?\n)?(?:---|\.\.\.)[ \t]*(?:\n|$)/

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
const richInline = new Set(['link', 'linkReference', 'image', 'imageReference', 'inlineMath'])

export function previewBlocks(document: string) {
  const offset = document.match(frontmatterPattern)?.[0].length ?? 0
  const body = document.slice(offset)
  const tree = parser.parse(body)
  const definitions = tree.children.filter(node => node.type === 'definition')
    .map(node => body.slice(node.position!.start.offset, node.position!.end.offset)).join('\n')
  return tree.children.flatMap(node => {
    const tasks: number[] = []
    let hasInline = false
    function visit(item: RootContent) {
      if (richInline.has(item.type)) hasInline = true
      if (item.type === 'listItem' && item.checked != null) {
        const start = item.position!.start.offset!
        const marker = /^(?:[-+*]|\d+[.)])[ \t]+\[([ xX])\]/.exec(body.slice(start))
        if (marker) tasks.push(start + marker[0].length - 2 + offset)
      }
      if ('children' in item) item.children.forEach(visit)
    }
    visit(node)
    if (!['table', 'math', 'code'].includes(node.type) && !tasks.length && !hasInline) return []
    const from = node.position!.start.offset! + offset
    const to = node.position!.end.offset! + offset
    return [{
      from, to, tasks, definitions,
      source: document.slice(from, to),
      code: node.type === 'code' ? { language: node.lang ?? '', value: node.value } : undefined
    }]
  })
}

type Block = ReturnType<typeof previewBlocks>[number]
export type PreviewActions = {
  imageUrl(url: string): string
  openLink(url: string): void
  copyCode(code: string): Promise<void>
  onError(error: unknown): void
}
let mermaidLoader: Promise<typeof import('mermaid').default> | undefined
let diagramId = 0

function Diagram({ value }: { value: string }) {
  const [image, setImage] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    let url = ''
    // 以图片载入生成的 SVG，禁用图表内的交互和 HTML 标签。
    mermaidLoader ??= import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, suppressErrorRendering: true })
      return mermaid
    })
    void mermaidLoader.then(mermaid => mermaid.render('studio-diagram-' + ++diagramId, value))
      .then(({ svg }) => {
        if (!active) return
        url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
        setImage(url)
      })
      .catch(() => { if (active) setFailed(true) })
    return () => { active = false; if (url) URL.revokeObjectURL(url) }
  }, [value])
  if (failed) return <><span role="status">无法渲染 Mermaid 图表</span><pre>{value}</pre></>
  return image ? <img src={image} alt="Mermaid 图表" /> : <span role="status">正在渲染 Mermaid 图表…</span>
}

function Code({ value, language, actions }: { value: string; language: string; actions: () => PreviewActions }) {
  const [copied, setCopied] = useState(false)
  const highlighted = hljs.getLanguage(language) ? hljs.highlight(value, { language }).value : null
  return <div className="preview-code">
    <div className="code-actions">
      <span>{language}</span>
      <button type="button" onClick={() => void actions().copyCode(value).then(() => setCopied(true), actions().onError)}>
        {copied ? '已复制' : '复制代码'}
      </button>
    </div>
    {highlighted === null ? <pre><code>{value}</code></pre>
      : <pre><code dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>}
  </div>
}

const components: Components = {
  input: ({ node: _node, checked, type, ...props }) => type === 'checkbox'
    ? <input type="checkbox" aria-label="切换任务状态" defaultChecked={checked} />
    : <input {...props} type={type} />
}

export class PreviewWidget extends WidgetType {
  private root?: Root
  private resize?: ResizeObserver

  constructor(private block: Block, private actions: () => PreviewActions) { super() }

  eq(other: PreviewWidget) {
    return this.block.from === other.block.from && this.block.source === other.block.source &&
      this.block.definitions === other.block.definitions && this.actions === other.actions
  }

  get estimatedHeight() {
    // 异步渲染完成前先按原文估算高度，长文滚动时仍可定位到文档末尾。
    return 28 + this.block.source.split('\n').length * 27
  }

  toDOM(view: EditorView) {
    const element = view.dom.ownerDocument.createElement('div')
    element.className = 'rendered-markdown'
    const { block } = this
    this.resize = new ResizeObserver(() => view.requestMeasure())
    this.resize.observe(element)
    this.root = createRoot(element)
    this.root.render(<>
      <div className="preview-edit"><button type="button" onClick={() => {
        view.dispatch({ selection: { anchor: block.from } })
        view.focus()
      }}>编辑源码</button></div>
      <div onChange={event => {
        if (!(event.target instanceof HTMLInputElement) || event.target.type !== 'checkbox') return
        const at = block.tasks[Array.from(event.currentTarget.querySelectorAll('input[type=checkbox]')).indexOf(event.target)]
        if (at === undefined) return
        view.dispatch({ changes: { from: at, to: at + 1, insert: event.target.checked ? 'x' : ' ' }, userEvent: 'input' })
      }} onClick={event => {
        if (!(event.target instanceof Element)) return
        const link = event.target.closest('a')
        if (!link) return
        event.preventDefault()
        const url = link.getAttribute('href')
        if (url) this.actions().openLink(url)
      }}>
        {block.code ? block.code.language.toLowerCase() === 'mermaid'
          ? <Diagram value={block.code.value} />
          : <Code {...block.code} actions={this.actions} />
          : <Markdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { trust: false }]]}
            components={components} skipHtml urlTransform={(url, key) => key === 'src' ? this.actions().imageUrl(url) : url}>
            {block.source + (block.definitions ? '\n\n' + block.definitions : '')}
          </Markdown>}
      </div>
    </>)
    return element
  }

  destroy() {
    this.resize?.disconnect()
    const root = this.root
    queueMicrotask(() => root?.unmount())
  }
  ignoreEvent() { return true }
}
