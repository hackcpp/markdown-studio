const fs = require('node:fs/promises')
const path = require('node:path')
const { split, noteInfo } = require('./metadata.cjs')
const { localLinks } = require('./markdown-links.cjs')

async function checkWorkspace(workspace, session, indexError) {
  const issues = []
  const assets = new Set()
  const references = new Set()
  let incomplete = false
  if (indexError) issues.push({ kind: 'index', detail: indexError })
  for (const tab of session?.tabs ?? []) {
    if (tab.draft) issues.push({ kind: 'draft', path: tab.path, detail: '有待处理的草稿' })
  }
  const scan = async (directory = '') => {
    let entries
    try { entries = await fs.readdir(await workspace.resolve(directory), { withFileTypes: true }) }
    catch (error) {
      incomplete = true
      issues.push({ kind: 'read', path: directory, detail: error.code ?? error.message })
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const file = directory ? directory + '/' + entry.name : entry.name
      if (entry.isDirectory()) { await scan(file); continue }
      if (!entry.isFile()) continue
      if (file.startsWith('Attachments/')) assets.add(file)
      if (!/\.md$/i.test(file)) continue
      try {
        const note = await workspace.read(file)
        if (!note) throw new Error('笔记已移除')
        const { document } = split(note.content)
        if (document?.errors.length) issues.push({ kind: 'yaml', path: file, detail: document.errors[0].message })
        else if (document) {
          try { noteInfo(note.content) }
          catch (error) { issues.push({ kind: 'yaml', path: file, detail: error.message }) }
        }
        for (const link of await localLinks(note.content, file)) {
          references.add(link.target)
          if (!link.image && !/\.md$/i.test(link.target)) continue
          try {
            const stat = await fs.stat(await workspace.resolve(link.target))
            if (!stat.isFile()) throw new Error('目标不是文件')
          } catch {
            issues.push({ kind: 'link', path: file, detail: link.target })
          }
        }
      } catch (error) {
        incomplete = true
        issues.push({ kind: 'read', path: file, detail: error.code ?? error.message })
      }
    }
  }
  await scan()
  if (!incomplete) {
    for (const asset of assets) {
      if (!references.has(asset)) issues.push({ kind: 'asset', path: asset, detail: '未在已扫描笔记中找到引用' })
    }
  }
  return issues
}

module.exports = { checkWorkspace }
