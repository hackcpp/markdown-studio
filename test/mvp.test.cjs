const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { Workspace } = require('../electron/workspace.cjs')
const { SearchIndex } = require('../electron/search.cjs')
const { LocalState } = require('../electron/local-state.cjs')
const { newNote, touchNote, noteInfo, updateInfo } = require('../electron/metadata.cjs')

async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-mvp-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

test('中文词组、两字标题及改名后移除旧索引', async t => {
  const dir = await temp(t)
  const ws = await Workspace.open(dir)
  const index = new SearchIndex(':memory:')
  t.after(() => index.db.close())
  await ws.create('', '算法入门', false, newNote('笔记') + '研究向量数据库与 SQL 示例。')
  assert.equal((await index.search(ws, '向量数据库'))[0].title, '笔记')
  assert.equal((await index.search(ws, '笔记'))[0].path, '算法入门.md')
  assert.equal((await index.search(ws, 'sql'))[0].title, '笔记')
  assert.deepEqual(await index.search(ws, '%_'), [])
  await ws.move('算法入门.md', '', '归档')
  assert.equal((await index.search(ws, '向量数据库'))[0].path, '归档.md')
  assert.deepEqual(await index.search(ws, '算法入门'), [])
  await fs.writeFile(path.join(dir, '归档.md'), '修改后的内容')
  assert.deepEqual(await index.search(ws, '向量数据库'), [])
})

test('索引文件损坏时仍可从笔记重建搜索数据', async t => {
  const dir = await temp(t)
  const file = path.join(dir, 'index.sqlite')
  await fs.writeFile(file, 'invalid sqlite file')
  const index = new SearchIndex(file)
  t.after(() => index.db.close())
  const ws = await Workspace.open(dir)
  await ws.create('', '测试', false, '待重建索引')
  assert.equal((await index.search(ws, '重建索引'))[0].path, '测试.md')
})

test('恢复文件保留原基准哈希并按工作区隔离', async t => {
  const dir = await temp(t)
  const first = new LocalState(dir)
  await first.remember('/my-notes')
  const draft = { text: '未保存内容', base: 'previous-disk-hash' }
  const session = { tabs: [{ path: '笔记.md', draft }], active: '笔记.md', mode: 'read' }
  await first.save('/my-notes', session)
  await first.save('/other-notes', { tabs: [], mode: 'split' })
  const second = new LocalState(dir)
  assert.equal(await second.recent(), '/my-notes')
  assert.deepEqual(await second.load('/my-notes'), session)
  assert.deepEqual((await second.load('/other-notes')).tabs, [])
})

test('文档信息保留自定义 YAML、正文与创建时间', () => {
  const content = '---\ntitle: Old\nauthor: Zoe # comment\ntags: [one]\ncreated: yesterday\nmodified: old # timestamp\n---\n\n# Body\n'
  const touched = touchNote(content, '2026-11-14T00:00:00.000Z')
  assert.equal(touched, content.replace('old #', '2026-11-14T00:00:00.000Z #'))
  const updated = updateInfo(touched, '新标题', ['中文', 'local'])
  assert.deepEqual(noteInfo(updated), { title: '新标题', tags: ['中文', 'local'] })
  assert.match(updated, /author: Zoe # comment/)
  assert.match(updated, /created: yesterday/)
  assert.ok(updated.endsWith('\n\n# Body\n'))
  assert.equal(touchNote('# Existing\n'), '# Existing\n')
  assert.throws(() => updateInfo('---\ntitle: [\n---\nBody', 'Safe', []), /YAML/)
})
