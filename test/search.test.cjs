const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { tempDirectory } = require('./helpers/temp-directory.cjs')
const { Workspace } = require('../electron/workspace.cjs')
const { SearchIndex } = require('../electron/search.cjs')
const { newNote } = require('../electron/metadata.cjs')

test('中文词组、两字标题及改名后移除旧索引', async t => {
  const dir = await tempDirectory(t)
  const ws = await Workspace.open(dir)
  const index = new SearchIndex(':memory:')
  t.after(() => index.db.close())
  await ws.create('', '算法入门', false, newNote('笔记') + '研究向量数据库与 SQL 示例。')
  assert.equal((await index.search(ws, '向量数据库'))[0].title, '笔记')
  assert.deepEqual((await index.search(ws, '向量数据库'))[0].fields, ['body'])
  assert.equal((await index.search(ws, '笔记'))[0].path, '算法入门.md')
  assert.deepEqual((await index.search(ws, '笔记'))[0].fields, ['title'])
  assert.equal((await index.search(ws, 'sql'))[0].title, '笔记')
  assert.deepEqual(await index.search(ws, '%_'), [])
  await ws.move('算法入门.md', '', '归档')
  assert.equal((await index.search(ws, '向量数据库'))[0].path, '归档.md')
  assert.deepEqual(await index.search(ws, '算法入门'), [])
  await fs.writeFile(path.join(dir, '归档.md'), '修改后的内容')
  assert.deepEqual(await index.search(ws, '向量数据库'), [])
})

test('索引文件损坏时仍可从笔记重建搜索数据', async t => {
  let index
  const dir = await tempDirectory(t, () => index?.db.close())
  const file = path.join(dir, 'index.sqlite')
  await fs.writeFile(file, 'invalid sqlite file')
  index = new SearchIndex(file)
  const ws = await Workspace.open(dir)
  await ws.create('', '测试', false, '待重建索引')
  assert.equal((await index.search(ws, '重建索引'))[0].path, '测试.md')
  await assert.rejects(index.rebuild({ root: ws.root, tree: async () => { throw new Error('读取失败') } }), /读取失败/)
  assert.equal((await index.search(ws, '重建索引'))[0].path, '测试.md')
  const result = await index.rebuild(ws)
  assert.equal(result.total, 1)
  assert.equal(await fs.readFile(path.join(dir, result.backup), 'utf8'), 'invalid sqlite file')
  assert.equal(index.error, null)
  assert.equal((await index.search(ws, '重建索引'))[0].path, '测试.md')
})

test('重建健康索引后，重新打开数据库仍保留其他工作区的记录', async t => {
  let index
  const dir = await tempDirectory(t, () => index?.db.close())
  const database = path.join(dir, 'index.sqlite')
  const firstDir = path.join(dir, 'first')
  const secondDir = path.join(dir, 'second')
  await Promise.all([fs.mkdir(firstDir), fs.mkdir(secondDir)])
  const [first, second] = await Promise.all([Workspace.open(firstDir), Workspace.open(secondDir)])
  await first.create('', '共享文件名', false, '# 第一工作区')
  await second.create('', '共享文件名', false, '# 第二工作区')
  index = new SearchIndex(database)
  await index.search(first, '第一工作区')
  await index.search(second, '第二工作区')
  await fs.writeFile(path.join(firstDir, '共享文件名.md'), '# 更新后的正文')
  const result = await index.rebuild(first)
  assert.deepEqual(result, { total: 1, backup: undefined })
  index.db.close()
  index = undefined
  index = new SearchIndex(database)

  // 直接查询新库，避免目录扫描补回丢失的索引记录。
  const rows = index.db.prepare('SELECT root, path, body FROM notes ORDER BY root').all()
  assert.deepEqual(rows.map(({ root, path, body }) => ({ root, path, body })), [
    { root: first.root, path: '共享文件名.md', body: '# 更新后的正文' },
    { root: second.root, path: '共享文件名.md', body: '# 第二工作区' }
  ])
})
