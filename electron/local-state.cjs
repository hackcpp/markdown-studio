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
  save(root, session) { return this.write(this.key(root), session) }
}

module.exports = { LocalState }
