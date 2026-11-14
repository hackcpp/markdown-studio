const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { titleFor } = require('./metadata.cjs')

function openIndex(file) {
  const db = new DatabaseSync(file)
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS notes USING fts5(
        root UNINDEXED, path, title, body, stamp UNINDEXED, tokenize='trigram'
      );
    `)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

class SearchIndex {
  constructor(file) {
    this.file = file
    this.error = null
    try { this.db = openIndex(file) }
    catch (error) {
      if (!/SQLITE|corrupt|database/i.test(error.code + ' ' + error.message)) throw error
      this.error = error.message
      this.db = openIndex(':memory:')
    }
  }

  async sync(workspace, db = this.db) {
    const existing = new Map(db.prepare('SELECT path, stamp FROM notes WHERE root = ?').all(workspace.root)
      .map(row => [row.path, row.stamp]))
    const changes = []
    const scan = async nodes => {
      for (const node of nodes) {
        if (node.children) { await scan(node.children); continue }
        const stamp = await workspace.stamp(node.path)
        if (stamp === null) continue
        const old = existing.get(node.path)
        existing.delete(node.path)
        if (old === stamp) continue
        const disk = await workspace.read(node.path)
        changes.push({ path: node.path, stamp, disk })
      }
    }
    await scan(await workspace.tree())
    const remove = db.prepare('DELETE FROM notes WHERE root = ? AND path = ?')
    const insert = db.prepare('INSERT INTO notes(root,path,title,body,stamp) VALUES (?,?,?,?,?)')
    db.exec('BEGIN')
    try {
      for (const key of existing.keys()) remove.run(workspace.root, key)
      for (const item of changes) {
        remove.run(workspace.root, item.path)
        if (item.disk) {
          const { body, title } = titleFor(item.disk.content, path.basename(item.path, path.extname(item.path)))
          insert.run(workspace.root, item.path, title, body, item.stamp)
        }
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  async rebuild(workspace) {
    if (this.file === ':memory:') throw new Error('未配置持久索引路径')
    const temp = this.file + '.new-' + randomUUID()
    let next
    let closed = false
    let backup
    try {
      next = openIndex(temp)
      if (!this.error) {
        const rows = this.db.prepare('SELECT root,path,title,body,stamp FROM notes WHERE root <> ?').iterate(workspace.root)
        const insert = next.prepare('INSERT INTO notes(root,path,title,body,stamp) VALUES (?,?,?,?,?)')
        next.exec('BEGIN')
        for (const row of rows) insert.run(row.root, row.path, row.title, row.body, row.stamp)
        next.exec('COMMIT')
      }
      await this.sync(workspace, next)
      const total = next.prepare('SELECT count(*) AS count FROM notes WHERE root = ?').get(workspace.root).count
      next.close()
      next = null
      if (this.error) {
        const copy = this.file + '.backup-' + randomUUID()
        await fs.copyFile(this.file, copy, require('node:fs').constants.COPYFILE_EXCL).then(() => { backup = path.basename(copy) }).catch(error => {
          if (error.code !== 'ENOENT') throw error
        })
      }
      this.db.close()
      closed = true
      await fs.rename(temp, this.file)
      this.db = openIndex(this.file)
      closed = false
      this.error = null
      return { total, backup }
    } finally {
      next?.close()
      if (closed) {
        const fresh = new SearchIndex(this.file)
        this.db = fresh.db
        this.error = fresh.error
      }
      await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
  }

  async search(workspace, query) {
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    await this.sync(workspace)
    const db = this.db
    const match = '%' + needle.replace(/[\\%_]/g, '\\$&') + '%'
    const rows = [...needle].length >= 3 && !/[\x00-\x1f]/.test(needle)
      ? db.prepare('SELECT path,title,body FROM notes WHERE root = ? AND notes MATCH ? ORDER BY rank LIMIT 100')
          .all(workspace.root, '"' + needle.replaceAll('"', '""') + '"')
      : db.prepare(`SELECT path,title,body FROM notes WHERE root = ? AND
          (path LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')
          ORDER BY path LIMIT 100`).all(workspace.root, match, match, match)
    return rows.map(({ path, title, body }) => {
      const fields = ['title', 'path', 'body'].filter(key => ({ title, path, body })[key].toLowerCase().includes(needle))
      const start = Math.max(0, body.toLowerCase().indexOf(needle) - 35)
      return { path, title, fields, excerpt: body.slice(start, start + 115).replace(/\s+/g, ' ').trim() }
    })
  }
}

module.exports = { SearchIndex }
