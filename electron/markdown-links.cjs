const path = require('node:path').posix
const { split } = require('./metadata.cjs')

function destination(source, node) {
  const start = node.position.start.offset
  const raw = source.slice(start, node.position.end.offset)
  const delimiter = node.type === 'definition' ? /(?<!\\)\]:\s*/g : /(?<!\\)\]\(\s*/g
  for (const match of [...raw.matchAll(delimiter)].reverse()) {
    const first = match.index + match[0].length
    const angle = raw[first] === '<'
    let from = first + Number(angle)
    let to = from
    let depth = 0
    for (; to < raw.length; to++) {
      const char = raw[to]
      if (char === '\\') { to++; continue }
      if (angle) {
        if (char === '>') break
        continue
      }
      if (/\s/.test(char) || char === ')' && depth === 0) break
      if (char === '(') depth++
      if (char === ')') depth--
    }
    if (raw.slice(from, to).replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_\x60{|}~])/g, '$1') === node.url) {
      return { from: start + from, to: start + to, angle }
    }
  }
}

async function localLinks(content, file) {
  const { fromMarkdown } = await import('mdast-util-from-markdown')
  const { body } = split(content)
  const offset = content.length - body.length
  const links = []
  const imageReferences = new Set()
  function visit(node) {
    if (node.type === 'imageReference') imageReferences.add(node.identifier)
    if (['link', 'image', 'definition'].includes(node.type)) {
      const range = destination(body, node)
      const url = node.url
      if (range && url && !/^(?:[a-z][a-z\d+.-]*:|[/\\#?])/i.test(url)) {
        const plain = url.split(/[?#]/, 1)[0]
        const raw = body.slice(range.from, range.to).split(/[?#]/, 1)[0]
        try {
          const decoded = decodeURIComponent(plain)
          if (!decoded.startsWith('/') && !/[\\:\x00]/.test(decoded)) {
            const target = path.normalize(path.join(path.dirname(file), decoded))
            if (target !== '..' && !target.startsWith('../')) {
              links.push({ target, from: range.from + offset, to: range.from + offset + raw.length,
                image: node.type === 'image', reference: node.type === 'definition' ? node.identifier : undefined, raw, angle: range.angle })
            }
          }
        } catch (error) {
          if (!(error instanceof URIError)) throw error
        }
      }
    }
    node.children?.forEach(visit)
  }
  visit(fromMarkdown(body))
  for (const link of links) if (imageReferences.has(link.reference)) link.image = true
  return links
}

async function rewriteLinks(content, file, nextFile, remap) {
  const edits = []
  for (const link of await localLinks(content, file)) {
    const nextTarget = remap(link.target)
    const next = path.relative(path.dirname(nextFile), nextTarget) || '.'
    const previous = path.relative(path.dirname(file), link.target) || '.'
    if (next === previous) continue
    const value = next.split('/').map(part => {
      if (/%[0-9a-f]{2}/i.test(link.raw)) return encodeURIComponent(part).replace(/[()']/g, char => '%' + char.charCodeAt(0).toString(16))
      return part.replace(link.angle ? /[<>%#?]/g : /[\s()%#?<>]/g, char => '%' + char.charCodeAt(0).toString(16).padStart(2, '0'))
    }).join('/')
    edits.push({ ...link, value })
  }
  for (const { from, to, value } of edits.sort((a, b) => b.from - a.from)) {
    content = content.slice(0, from) + value + content.slice(to)
  }
  return content
}

module.exports = { localLinks, rewriteLinks }
