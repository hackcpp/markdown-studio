const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { rewriteLinks } = require('./markdown-links.cjs')

const imageTypes = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif'
}
const isNote = name => /\.md$/i.test(name)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const inside = (base, target) => target === base || target.startsWith(base + '/')

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
          ? { path: file, name: item.name, attachment: inside('Attachments', file), children: await this.tree(file) }
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
      const handle = await fs.open(filename, 'r')
      try {
        const info = await handle.stat({ bigint: true })
        if (!info.isFile()) return null
        const bytes = await handle.readFile()
        return { content: bytes.toString('utf8'), hash: digest(bytes),
          ...(info.ino !== 0n && { identity: info.dev + ':' + info.ino }) }
      } finally {
        await handle.close()
      }
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

  async movedNote(previous, identity, hash) {
    if (!identity || !hash || await this.read(previous)) return null
    const candidates = []
    const visit = async nodes => {
      for (const node of nodes) {
        if (node.children) { await visit(node.children); continue }
        const stat = await fs.lstat(await this.resolve(node.path), { bigint: true }).catch(error => {
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
          throw error
        })
        if (!stat) continue
        if (stat.dev + ':' + stat.ino !== identity) continue
        const disk = await this.read(node.path)
        if (disk?.identity === identity && disk.hash === hash) candidates.push(node.path)
      }
    }
    await visit(await this.tree())
    return candidates.length === 1 ? candidates[0] : null
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
    const info = await fs.stat(file, { bigint: true }).catch(() => null)
    return { conflict: false, disk: { content, hash: digest(bytes),
      ...(info && info.ino !== 0n && { identity: info.dev + ':' + info.ino }) } }
  }

  async create(directory, name, folder, content = '') {
    const relative = child(directory, folder || isNote(name) ? name : name + '.md')
    const destination = await this.resolve(relative, true)
    if (folder) await fs.mkdir(destination)
    else await fs.writeFile(destination, content, { flag: 'wx' })
    return relative
  }

  async move(relative, directory, name, blocked = []) {
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

    const remap = file => inside(relative, file) ? target + file.slice(relative.length) : file
    const updates = []
    const snapshots = []
    const collect = async note => {
      const disk = await this.read(note)
      if (!disk) throw new Error('文件在移动前发生变化：' + note)
      const moved = remap(note)
      const content = await rewriteLinks(disk.content, note, moved, remap)
      if (moved !== note || content !== disk.content) snapshots.push({ note, disk })
      if (content !== disk.content) updates.push({ moved, disk, content })
    }
    const visit = async nodes => {
      for (const node of nodes) {
        if (node.children) await visit(node.children)
        else await collect(node.path)
      }
    }
    await visit(await this.tree())
    const blockedPaths = new Set()
    for (const { path: file, text } of blocked) {
      if (inside(relative, file) || snapshots.some(item => item.note === file) ||
          await rewriteLinks(text, file, file, remap) !== text) blockedPaths.add(file)
    }
    if (blockedPaths.size) throw new Error('请先保存笔记或处理冲突：' + [...blockedPaths].join('、'))
    for (const { note, disk } of snapshots) {
      if ((await this.read(note))?.hash !== disk.hash) throw new Error('文件在移动前发生变化：' + note)
    }
    if (await fs.lstat(destination).catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    })) throw new Error('目标位置已有同名文件或文件夹')
    if (info.isFile()) {
      await fs.link(source, destination)
      try { await fs.unlink(source) }
      catch (error) { await fs.unlink(destination); throw error }
    } else await fs.rename(source, destination)
    const written = []
    try {
      for (const update of updates) {
        const result = await this.save(update.moved, update.content, update.disk.hash)
        if (result.conflict) throw new Error('文件在移动期间受到外部修改：' + update.moved)
        written.push({ ...update, hash: result.disk.hash })
      }
    } catch (error) {
      try {
        for (const update of written.reverse()) {
          const result = await this.save(update.moved, update.disk.content, update.hash, undefined, false)
          if (result.conflict) throw new Error('文件受到外部修改')
        }
        if (await fs.lstat(source).catch(cause => {
          if (cause.code === 'ENOENT') return null
          throw cause
        })) throw new Error('原路径已被占用')
        await fs.rename(destination, source)
      } catch {
        throw new Error('移动后无法完成回滚，请在目标目录检查文件和图片链接')
      }
      throw error
    }
    return target
  }

  async trashPreview(relative) {
    if (!relative || relative === 'Attachments' || inside('Attachments/images', relative)) {
      throw new Error('无法将此目录移至废纸篓')
    }
    const file = await this.resolve(relative)
    const info = await fs.stat(file)
    if (!info.isDirectory() && (!info.isFile() || !isNote(relative))) throw new Error('无法移除此文件')
    const inventory = []
    let files = 0
    let directories = 0
    const scan = async (absolute, relativePath) => {
      const entries = await fs.readdir(absolute, { withFileTypes: true })
      entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      for (const entry of entries) {
        const item = relativePath + '/' + entry.name
        inventory.push([item, entry.isDirectory(), entry.isSymbolicLink()])
        if (entry.isDirectory()) {
          directories++
          await scan(path.join(absolute, entry.name), item)
        } else files++
      }
    }
    if (info.isDirectory()) await scan(file, relative)
    return { directory: info.isDirectory(), files, directories, signature: digest(JSON.stringify([
      relative, info.dev, info.ino, info.isDirectory(), inventory
    ])) }
  }

  async trash(relative, trashItem, signature) {
    const preview = await this.trashPreview(relative)
    if (signature !== undefined && signature !== preview.signature) return preview
    if (preview.directory && signature === undefined) return preview
    const file = await this.resolve(relative)
    await trashItem(file)
    return null
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
