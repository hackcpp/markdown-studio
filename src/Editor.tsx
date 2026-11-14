import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { basicSetup, EditorView } from 'codemirror'
import { Compartment, EditorState, StateEffect, StateField, Transaction, type Range } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { Decoration, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { redo, undo } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { frontmatterPattern, previewBlocks, PreviewWidget, type PreviewActions } from './markdown-preview'

type Props = PreviewActions & {
  text: string
  visible: boolean
  live: boolean
  toolbar: HTMLDivElement | null
  jump?: { line: number }
  onEdit(text: string): void
  onSave(): void
  onPaste(): Promise<string>
}

function frontmatter(state: EditorState) {
  const match = frontmatterPattern.exec(state.doc.toString())
  return match ? Decoration.set([Decoration.replace({ block: true }).range(0, match[0].length)]) : Decoration.none
}

const hideFrontmatter = StateField.define<DecorationSet>({
  create: frontmatter,
  update: (decorations, transaction) => transaction.docChanged ? frontmatter(transaction.state) : decorations,
  provide: field => EditorView.decorations.from(field)
})

const liveFormatting = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = this.build(view) }
  update(update: ViewUpdate) { this.decorations = this.build(update.view) }
  build(view: EditorView) {
    const ranges: Range<Decoration>[] = []
    const selections = view.state.selection.ranges
    for (const { from, to } of view.visibleRanges) {
      syntaxTree(view.state).iterate({ from, to, enter(node) {
        const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name)
        if (heading) {
          ranges.push(Decoration.line({ class: 'live-h' + heading[1] }).range(view.state.doc.lineAt(node.from).from))
        }
        if (node.name === 'Blockquote') {
          ranges.push(Decoration.line({ class: 'live-quote' }).range(view.state.doc.lineAt(node.from).from))
        }
        if (['HeaderMark', 'EmphasisMark', 'StrikethroughMark', 'QuoteMark', 'CodeMark'].includes(node.name)) {
          const line = view.state.doc.lineAt(node.from)
          if (!selections.some(selection => selection.from <= line.to && selection.to >= line.from)) {
            ranges.push(Decoration.mark({ class: 'live-marker' }).range(node.from, node.to))
          }
        }
      } })
    }
    return Decoration.set(ranges, true)
  }
}, { decorations: plugin => plugin.decorations })
const liveExtensions = [hideFrontmatter, liveFormatting]

function richPreview(actions: () => PreviewActions) {
  const focus = StateEffect.define<boolean>()
  const field = StateField.define({
    create(state) {
      const blocks = previewBlocks(state.doc.toString())
      return { focused: false, blocks, decorations: decorate(state, blocks, false) }
    },
    update(value, transaction) {
      const effect = transaction.effects.find(item => item.is(focus))
      if (!effect && !transaction.docChanged && !transaction.selection) return value
      const focused = effect?.value ?? value.focused
      const blocks = transaction.docChanged ? previewBlocks(transaction.newDoc.toString()) : value.blocks
      return { focused, blocks, decorations: decorate(transaction.state, blocks, focused) }
    },
    provide: field => EditorView.decorations.from(field, value => value.decorations)
  })
  function decorate(state: EditorState, blocks: ReturnType<typeof previewBlocks>, focused: boolean) {
    return Decoration.set(blocks.flatMap(block => {
      if (focused && state.selection.ranges.some(range => range.from <= block.to && range.to >= block.from)) return []
      return [Decoration.replace({ block: true, widget: new PreviewWidget(block, actions) }).range(block.from, block.to)]
    }))
  }
  return [field, EditorView.focusChangeEffect.of((_state, focused) => focus.of(focused))]
}

export function Editor(props: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView>(null)
  const latest = useRef(props)
  const liveMode = useRef(new Compartment())
  const rich = useRef<ReturnType<typeof richPreview> | null>(null)
  rich.current ??= richPreview(() => latest.current)
  latest.current = props

  useEffect(() => {
    let alive = true
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: latest.current.text,
        extensions: [
          basicSetup, markdown({ base: markdownLanguage }), EditorView.lineWrapping,
          liveMode.current.of(latest.current.live ? [...liveExtensions, ...rich.current!] : []),
          EditorView.contentAttributes.of({ 'aria-label': 'Markdown 编辑器' }),
          EditorView.updateListener.of(update => {
            if (update.docChanged && update.transactions.some(tr => !tr.annotation(Transaction.remote))) {
              latest.current.onEdit(update.state.doc.toString())
            }
          }),
          EditorView.domEventHandlers({
            keydown(event) {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                latest.current.onSave()
                return true
              }
              return false
            },
            paste(event) {
              if (!Array.from(event.clipboardData?.items ?? []).some(item => item.type.startsWith('image/'))) return false
              void paste()
              return true
            }
          })
        ]
      })
    })
    async function paste() {
      try {
        const url = await latest.current.onPaste()
        if (alive) editor.dispatch(editor.state.replaceSelection('![](' + url + ')'))
      } catch (error) {
        latest.current.onError(error)
      }
    }
    view.current = editor
    return () => { alive = false; editor.destroy(); view.current = null }
  }, [])

  useEffect(() => {
    const editor = view.current
    if (!editor || editor.state.doc.toString() === props.text) return
    const { anchor, head } = editor.state.selection.main
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: props.text },
      selection: { anchor: Math.min(anchor, props.text.length), head: Math.min(head, props.text.length) },
      annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)]
    })
  }, [props.text])

  useEffect(() => {
    if (props.visible) view.current?.requestMeasure()
  }, [props.visible])

  useEffect(() => {
    view.current?.dispatch({ effects: liveMode.current.reconfigure(props.live ? [...liveExtensions, ...rich.current!] : []) })
  }, [props.live])

  useEffect(() => {
    const editor = view.current
    if (!props.visible || !props.jump || !editor) return
    const line = editor.state.doc.line(Math.min(props.jump.line, editor.state.doc.lines))
    editor.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'start' }) })
    editor.focus()
  }, [props.jump, props.visible])

  function wrap(before: string, after = '', placeholder = '') {
    const editor = view.current
    if (!editor) return
    const { from, to } = editor.state.selection.main
    const text = editor.state.sliceDoc(from, to) || placeholder
    editor.dispatch({
      changes: { from, to, insert: before + text + after },
      selection: { anchor: from + before.length, head: from + before.length + text.length },
      userEvent: 'input'
    })
    editor.focus()
  }

  function prefix(value: string) {
    const editor = view.current
    if (!editor) return
    const { from, to } = editor.state.selection.main
    const changes = []
    const last = editor.state.doc.lineAt(Math.max(from, to - 1)).number
    for (let number = editor.state.doc.lineAt(from).number; number <= last; number++) {
      changes.push({ from: editor.state.doc.line(number).from, insert: value })
    }
    editor.dispatch({ changes, userEvent: 'input' })
    editor.focus()
  }

  return <div className={props.live ? 'editor live-editor' : 'editor'} hidden={!props.visible}>
    {props.visible && props.toolbar && createPortal(<div className="format">
      <button title="粗体" onClick={() => wrap('**', '**', '文字')}><strong>B</strong></button>
      <button title="斜体" onClick={() => wrap('*', '*', '文字')}><em>I</em></button>
      <button title="删除线" onClick={() => wrap('~~', '~~', '文字')}><s>S</s></button>
      <button title="标题" onClick={() => prefix('# ')}>H</button>
      <span className="tool-separator" />
      <button title="无序列表" onClick={() => prefix('- ')}>☷</button>
      <button title="有序列表" onClick={() => prefix('1. ')}>1.</button>
      <button title="引用" onClick={() => prefix('> ')}>❞</button>
      <button title="行内代码" onClick={() => wrap('`', '`', 'code')}>{'</>'}</button>
      <span className="tool-separator" />
      <button title="链接" onClick={() => wrap('[', '](https://)', '链接')}>↗</button>
      <button title="图片链接" onClick={() => wrap('![', '](./image.png)', '图片描述')}>▧</button>
      <button title="插入表格" onClick={() => wrap('\n| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |\n')}>▦</button>
      <button title="撤销" onClick={() => { if (view.current) { undo(view.current); view.current.focus() } }}>↶</button>
      <button title="重做" onClick={() => { if (view.current) { redo(view.current); view.current.focus() } }}>↷</button>
    </div>, props.toolbar)}
    <div ref={host} className="editor-host" />
  </div>
}
