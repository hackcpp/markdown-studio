const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

async function tempDirectory(t, close = () => {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-studio-test-'))
  t.after(async () => {
    try { await close() }
    finally { await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }) }
  })
  return dir
}

module.exports = { tempDirectory }
