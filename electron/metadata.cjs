const { parseDocument, isMap } = require('yaml')

const block = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m

function split(content) {
  const match = block.exec(content)
  if (!match || match.index !== 0) return { body: content }
  const source = match[1]
  const document = parseDocument(source)
  return { body: content.slice(match[0].length), source, document, length: match[0].length }
}

function titleFor(content, fallback) {
  const { body, document } = split(content)
  const title = document && !document.errors.length && isMap(document.contents) ? document.get('title') : null
  return { body, title: typeof title === 'string' && title.trim() ? title.trim() : fallback }
}

function newNote(title, now = new Date().toISOString()) {
  return '---\ntitle: ' + JSON.stringify(title) + '\ncreated: ' + now +
    '\nmodified: ' + now + '\ntags: []\n---\n\n'
}

function touchNote(content, now = new Date().toISOString()) {
  const { source, document } = split(content)
  if (!document || document.errors.length || !isMap(document.contents)) return content
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const start = content.indexOf('\n') + 1
  const field = document.contents.items.find(({ key }) => key?.value === 'modified')
  if (!field) return content.slice(0, start) + 'modified: ' + now + eol + content.slice(start)
  const range = field.value?.range
  // 保留自定义字段、注释和原始排版。复杂值留给用户在源码中编辑。
  if (!range || typeof field.value.value !== 'string' || /^[>|]|[\r\n]/.test(source.slice(range[0], range[1]))) return content
  return content.slice(0, start + range[0]) + now + content.slice(start + range[1])
}

function noteInfo(content) {
  const { document } = split(content)
  if (document && (document.errors.length || !isMap(document.contents))) {
    throw new Error('请先在源码中修正 YAML 文档信息')
  }
  const title = document?.get('title')
  const tags = document?.get('tags', true)
  if (title !== undefined && typeof title !== 'string' ||
      tags !== undefined && (!Array.isArray(tags?.items) || tags.items.some(item => typeof item?.value !== 'string'))) {
    throw new Error('标题和标签格式需要在源码中修正')
  }
  return { title: title ?? '', tags: tags?.items.map(item => item.value) ?? [] }
}

function updateInfo(content, title, tags) {
  noteInfo(content)
  const { document, body } = split(content)
  if (!document) {
    const seed = split(newNote(title))
    seed.document.set('tags', tags)
    return '---\n' + seed.document.toString() + '---\n\n' + content
  }
  document.set('title', title)
  document.set('tags', tags)
  return '---\n' + document.toString() + '---\n' + body
}

module.exports = { newNote, titleFor, touchNote, noteInfo, updateInfo }
