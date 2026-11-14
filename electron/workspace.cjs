const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')

const imageTypes = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif'
}
const isNote = name => /\.md$/i.test(name)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const inside = (base, target) => target === base || target.startsWith(base + '/')
const managedPath = /^Attachments\/images\/[a-f0-9-]+\.png$/
const managedImage = /^!\[\]\(((?:\.\.\/)*Attachments\/images\/[a-f0-9-]+\.png)\)$/

function parts(relative) {
  if (typeof relative !== 'string') throw new Error('无效的文件路径')
  const segments = relative === '' ? [] : relative.split('/')
  if (segments.some(part => !part || part === '.' || part === '..' || /[\\:\0]/.test(part))) {
    throw new Error('无效的文件路径')
  }
  return segments
}

function child(parent, name) {
  if (typeof name !== 'string' || !name.trim() || name !== name.trim() ||
      /[<>:"/\\|?*\x00-\x1f]/.test(name) || name.startsWith('.') || name.endsWith('.') ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error('请输入有效的文件名或文件夹名')
  }
  return parent ? parent + '/' + name : name
}

async function atomicWrite(file, content, mode, verify) {
  const temp = path.join(path.dirname(file), '.studio-' + randomUUID())
  const handle = await fs.open(temp, 'wx', mode)
  try {
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (verify && !await verify()) return false
    await fs.rename(temp, file)
    return true
  } finally {
    await fs.unlink(temp).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

class Workspace {
  static async open(directory) {
    return new Workspace(await fs.realpath(directory))
  }

  constructor(root) {
    this.root = root
  }

  async resolve(relative, allowMissing = false) {
    const segments = parts(relative)
    let current = this.root
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment)
      const info = await fs.lstat(current).catch(error => {
        if (allowMissing && index === segments.length - 1 && error.code === 'ENOENT') return null
        throw error
      })
      if (info?.isSymbolicLink()) throw new Error('工作区不支持符号链接')
    }
    return current
  }

  async tree(directory = '') {
    const entries = await fs.readdir(await this.resolve(directory), { withFileTypes: true })
    const visible = entries.filter(item =>
      !item.name.startsWith('.') && !/[\\:]/.test(item.name) &&
      (item.isDirectory() || (item.isFile() && isNote(item.name))))
    visible.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) ||
      a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
    const nodes = []
    for (const item of visible) {
      const file = directory ? directory + '/' + item.name : item.name
      try {
        nodes.push(item.isDirectory()
          ? { path: file, name: item.name, children: await this.tree(file) }
          : { path: file, name: item.name })
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    return nodes
  }

  async read(relative) {
    if (!isNote(relative)) throw new Error('请选择 Markdown 文件')
    try {
      const filename = await this.resolve(relative)
      if (!(await fs.stat(filename)).isFile()) return null
      const bytes = await fs.readFile(filename)
      return { content: bytes.toString('utf8'), hash: digest(bytes) }
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
      throw error
    }
  }

  async stamp(relative) {
    try {
      const info = await fs.stat(await this.resolve(relative), { bigint: true })
      return info.isFile() ? [info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':') : null
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
      throw error
    }
  }

  async save(relative, content, base, backup, preserveLineEndings = true, prepare = value => value) {
    const current = await this.read(relative)
    if ((current?.hash ?? null) !== base) return { conflict: true, disk: current }
    if (preserveLineEndings && current && /\r\n/.test(current.content) && !/(?<!\r)\n/.test(current.content)) {
      content = content.replace(/(?<!\r)\n/g, '\r\n')
    }
    if (current?.content === content) return { conflict: false, disk: current }
    content = prepare(content)
    // 只有主动覆盖冲突时才备份磁盘版本。
    if (backup && current) await backup(current.content)
    const file = await this.resolve(relative, true)
    const mode = current ? (await fs.stat(file)).mode & 0o777 : 0o600
    const bytes = Buffer.from(content, 'utf8')
    if (!current) {
      try {
        await fs.writeFile(file, bytes, { flag: 'wx', mode })
      } catch (error) {
        if (error.code === 'EEXIST') return { conflict: true, disk: await this.read(relative) }
        throw error
      }
    } else if (!await atomicWrite(file, bytes, mode, async () => (await this.read(relative))?.hash === base)) {
      return { conflict: true, disk: await this.read(relative) }
    }
    return { conflict: false, disk: { content, hash: digest(bytes) } }
  }

  async create(directory, name, folder, content = '') {
    const relative = child(directory, folder || isNote(name) ? name : name + '.md')
    const destination = await this.resolve(relative, true)
    if (folder) await fs.mkdir(destination)
    else await fs.writeFile(destination, content, { flag: 'wx' })
    return relative
  }

  async move(relative, directory, name) {
    if (!relative) throw new Error('无法移动工作区根目录')
    const source = await this.resolve(relative)
    const info = await fs.stat(source)
    if (!info.isDirectory() && (!info.isFile() || !isNote(relative))) throw new Error('无法移动该文件')
    if (relative === 'Attachments' || inside('Attachments/images', relative)) {
      throw new Error('受管理的图片目录需要保留原路径')
    }
    const target = child(directory, info.isDirectory() || isNote(name) ? name : name + '.md')
    if (target === relative) return target
    if (inside(relative, directory)) throw new Error('无法移入自身或下级文件夹')
    const destination = await this.resolve(target, true)
    if (await fs.lstat(destination).catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    })) throw new Error('目标位置已有同名文件或文件夹')

    // 同层重命名无需调整相对链接。跨层移动时只调整应用生成的图片链接。
    const updates = []
    const collect = async note => {
      const disk = await this.read(note)
      if (!disk) throw new Error('文件在移动前发生变化')
      const moved = target + note.slice(relative.length)
      const oldDirectory = path.posix.dirname(note)
      const newDirectory = path.posix.dirname(moved)
      const { fromMarkdown } = await import('mdast-util-from-markdown')
      const edits = []
      function visitImage(node) {
        if (node.type === 'image') {
          const { start, end } = node.position
          const match = managedImage.exec(disk.content.slice(start.offset, end.offset))
          if (match) {
            const resolved = path.posix.normalize(path.posix.join(oldDirectory, match[1]))
            if (managedPath.test(resolved)) {
              edits.push({ start: start.offset, end: end.offset, url: path.posix.relative(newDirectory, resolved) })
            }
          }
        }
        node.children?.forEach(visitImage)
      }
      visitImage(fromMarkdown(disk.content))
      let content = disk.content
      for (const edit of edits.reverse()) {
        content = content.slice(0, edit.start) + '![](' + edit.url + ')' + content.slice(edit.end)
      }
      if (content !== disk.content) updates.push({ moved, disk, content })
    }
    const visit = async nodes => {
      for (const node of nodes) {
        if (node.children) await visit(node.children)
        else await collect(node.path)
      }
    }
    if (path.posix.dirname(relative) !== path.posix.dirname(target)) {
      if (info.isDirectory()) await visit(await this.tree(relative))
      else await collect(relative)
    }
    await fs.rename(source, destination)
    const written = []
    try {
      for (const update of updates) {
        const result = await this.save(update.moved, update.content, update.disk.hash)
        if (result.conflict) throw new Error('文件在移动期间受到外部修改')
        written.push({ ...update, hash: result.disk.hash })
      }
    } catch (error) {
      try {
        for (const update of written.reverse()) {
          const result = await this.save(update.moved, update.disk.content, update.hash, undefined, false)
          if (result.conflict) throw new Error('文件受到外部修改')
        }
        await fs.rename(destination, source)
      } catch {
        throw new Error('移动后无法完成回滚，请在目标目录检查文件和图片链接')
      }
      throw error
    }
    return target
  }

  async trash(relative, trashItem) {
    if (!relative || relative === 'Attachments' || inside('Attachments/images', relative)) {
      throw new Error('无法将此目录移至废纸篓')
    }
    const file = await this.resolve(relative)
    const info = await fs.stat(file)
    if (!info.isDirectory() && (!info.isFile() || !isNote(relative))) throw new Error('无法移除此文件')
    await trashItem(file)
  }

  async paste(relative, png) {
    if (!await this.read(relative)) throw new Error('请先打开磁盘上的笔记')
    const bytes = Buffer.from(png)
    if (bytes.length > 25 * 1024 * 1024 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
      throw new Error('无法保存这张图片，图片大小上限为 25 MB')
    }
    for (const directory of ['Attachments', 'Attachments/images']) {
      await fs.mkdir(await this.resolve(directory, true)).catch(error => {
        if (error.code !== 'EEXIST') throw error
      })
    }
    const image = 'Attachments/images/' + randomUUID() + '.png'
    await fs.writeFile(await this.resolve(image, true), bytes, { flag: 'wx' })
    return path.posix.relative(path.posix.dirname(relative), image)
  }

  async image(relative) {
    const type = imageTypes[path.extname(relative).toLowerCase()]
    if (!type) throw new Error('图片格式不受支持')
    const file = await this.resolve(relative)
    if (!(await fs.stat(file)).isFile()) throw new Error('图片不存在')
    return { file, type }
  }
}

module.exports = { Workspace, atomicWrite }
