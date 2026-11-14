const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { atomicWrite } = require('./workspace.cjs')

class LocalState {
  constructor(directory) { this.directory = directory }

  async read(file) {
    try {
      return JSON.parse(await fs.readFile(path.join(this.directory, file), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  async write(file, value) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    await atomicWrite(path.join(this.directory, file), JSON.stringify(value), 0o600)
  }

  key(root) { return createHash('sha256').update(root).digest('hex') + '.json' }
  async recent() { return (await this.read('workspace.json'))?.root }
  remember(root) { return this.write('workspace.json', { root }) }
  load(root) { return this.read(this.key(root)) }
  async save(root, session) {
    const previous = new Map((await this.load(root))?.tabs?.map(item => [item.path, item.draft]) ?? [])
    const now = new Date().toISOString()
    const tabs = session.tabs.map(item => {
      if (!item.draft) return item
      const old = previous.get(item.path)
      const { text, base, baseline, identity } = item.draft
      const same = old && old.text === text && old.base === base && old.baseline === baseline && old.identity === identity
      return { ...item, draft: { ...item.draft, checkedAt: same ? old.checkedAt ?? now : now } }
    })
    await this.write(this.key(root), { ...session, tabs })
    return tabs.flatMap(item => item.draft ? [{ path: item.path, checkedAt: item.draft.checkedAt }] : [])
  }
}

module.exports = { LocalState }
