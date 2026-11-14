const { parseDocument, isMap, isScalar, isSeq } = require('yaml')

const block = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m

function split(content) {
  const match = block.exec(content)
  if (!match || match.index !== 0) return { body: content }
  const source = match[1]
  const document = parseDocument(source)
  const start = content.indexOf('\n') + 1
  return { body: content.slice(match[0].length), source, document, start, eol: content[start - 2] === '\r' ? '\r\n' : '\n' }
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
  const { source, document, start, eol } = split(content)
  if (!document || document.errors.length || !isMap(document.contents)) return content
  const field = document.contents.items.find(({ key }) => key?.value === 'modified')
  if (!field) return document.contents.flow ? content :
    content.slice(0, start + source.length) + rootIndent(document, source) + 'modified: ' + now + eol + content.slice(start + source.length)
  if (!simpleScalar(field.value, source)) return content
  const [from, to] = field.value.range
  return content.slice(0, start + from) + represent(now, field.value.type) + content.slice(start + to)
}

function rootIndent(document, source) {
  const from = document.contents?.items?.[0]?.key?.range?.[0]
  if (from === undefined) return ''
  return /^[ \t]*/.exec(source.slice(source.lastIndexOf('\n', from - 1) + 1, from))[0]
}

function simpleScalar(value, source) {
  return isScalar(value) && typeof value.value === 'string' && value.range &&
    ['PLAIN', 'QUOTE_DOUBLE', 'QUOTE_SINGLE'].includes(value.type) &&
    !value.anchor && !value.tag && !/[\r\n]/.test(source.slice(value.range[0], value.range[1]))
}

function represent(value, style) {
  if (style === 'QUOTE_SINGLE') return "'" + value.replaceAll("'", "''") + "'"
  if (style === 'PLAIN' && /^[\p{L}\p{N}_-][\p{L}\p{N}_ .:+-]*$/u.test(value) &&
      !/:\s|\s$/.test(value) && parseDocument(value).contents?.value === value) return value
  return JSON.stringify(value)
}

function noteInfo(content) {
  const { document, source } = split(content)
  if (document && (document.errors.length || document.contents !== null && !isMap(document.contents))) {
    throw new Error('请先在源码中修正 YAML 文档信息')
  }
  const title = document?.get('title', true)
  const tags = document?.get('tags', true)
  if (title !== undefined && !simpleScalar(title, source) ||
      tags !== undefined && (!isSeq(tags) || !tags.range || tags.anchor || tags.tag ||
        tags.items.some(item => !simpleScalar(item, source)))) {
    throw new Error('标题或标签结构较复杂，请在源码模式中编辑')
  }
  return { title: title?.value ?? '', tags: tags?.items.map(item => item.value) ?? [] }
}

function updateInfo(content, title, tags) {
  const old = noteInfo(content)
  const { document, source, start, eol } = split(content)
  if (!document) {
    const seed = split(newNote(title))
    seed.document.set('tags', tags)
    const newline = content.includes('\r\n') ? '\r\n' : '\n'
    const bom = content.startsWith('\uFEFF') ? '\uFEFF' : ''
    return bom + ('---\n' + seed.document.toString() + '---\n\n').replaceAll('\n', newline) + content.slice(bom.length)
  }
  const edits = []
  const missing = []
  function add(key, value) {
    if (document.contents?.flow) throw new Error('请在源码模式中添加 YAML 字段')
    missing.push(rootIndent(document, source) + key + ': ' + value + eol)
  }
  if (title !== old.title) {
    const node = document.get('title', true)
    if (!node) add('title', JSON.stringify(title))
    else edits.push([node.range[0], node.range[1], represent(title, node.type)])
  }
  if (tags.length !== old.tags.length || tags.some((tag, index) => tag !== old.tags[index])) {
    const node = document.get('tags', true)
    if (!node) add('tags', JSON.stringify(tags))
    else if (node.items.length === tags.length) {
      node.items.forEach((item, index) => {
        if (item.value !== tags[index]) edits.push([item.range[0], item.range[1], represent(tags[index], item.type)])
      })
    } else if (node.flow && !/[\r\n#]/.test(source.slice(node.range[0], node.range[1]))) {
      edits.push([node.range[0], node.range[1], '[' + tags.map((tag, index) => represent(tag, node.items[index]?.type)).join(', ') + ']'])
    } else if (!node.flow && tags.length > 0 && !/#/.test(source.slice(node.range[0], node.range[2]))) {
      const indent = /^[ \t]*/.exec(source.slice(source.lastIndexOf('\n', node.range[0] - 1) + 1, node.range[0]))[0]
      const block = tags.map((tag, index) => '- ' + represent(tag, node.items[index]?.type)).join(eol + indent)
      edits.push([node.range[0], node.range[1], block + (source.slice(node.range[0], node.range[1]).endsWith(eol) ? eol : '')])
    } else throw new Error('标签结构较复杂，请在源码模式中编辑')
  }
  if (missing.length) edits.push([source.length, source.length, missing.join('')])
  for (const [from, to, value] of edits.sort((a, b) => b[0] - a[0])) {
    content = content.slice(0, start + from) + value + content.slice(start + to)
  }
  return content
}

module.exports = { split, newNote, titleFor, touchNote, noteInfo, updateInfo }
