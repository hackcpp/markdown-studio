const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { Workspace } = require('../electron/workspace.cjs')
const { SearchIndex } = require('../electron/search.cjs')
const { LocalState } = require('../electron/local-state.cjs')
const { checkWorkspace } = require('../electron/workspace-check.cjs')
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-index-'))
  const file = path.join(dir, 'index.sqlite')
  await fs.writeFile(file, 'invalid sqlite file')
  const index = new SearchIndex(file)
  t.after(async () => {
    index.db.close()
    await fs.rm(dir, { recursive: true, force: true })
  })
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

test('工作区检查报告失效链接、YAML、孤立附件、索引异常和草稿，且不写笔记', async t => {
  const dir = await temp(t)
  const ws = await Workspace.open(dir)
  await fs.mkdir(path.join(dir, 'Attachments', 'images'), { recursive: true })
  await fs.writeFile(path.join(dir, 'Attachments', 'images', 'used.png'), 'image')
  await fs.writeFile(path.join(dir, 'Attachments', 'images', 'unused.png'), 'image')
  const content = '---\ntitle: [\n---\n\n[笔记](missing.md#anchor)\n\n![图片][pic]\n\n[pic]: Attachments/images/used.png'
  const file = await ws.create('', '检查', false, content)
  const issues = await checkWorkspace(ws, { tabs: [{ path: '草稿.md', draft: true }] }, '索引损坏')
  assert.deepEqual(issues.map(issue => issue.kind).sort(), ['asset', 'draft', 'index', 'link', 'yaml'])
  assert.equal(issues.find(issue => issue.kind === 'link').detail, 'missing.md')
  assert.equal(issues.find(issue => issue.kind === 'asset').path, 'Attachments/images/unused.png')
  assert.equal((await ws.read(file)).content, content)
})

test('恢复文件保留原基准哈希并按工作区隔离', async t => {
  const dir = await temp(t)
  const first = new LocalState(dir)
  await first.remember('/my-notes')
  const draft = { text: '未保存内容', base: 'previous-disk-hash' }
  const session = { tabs: [{ path: '笔记.md', draft }], active: '笔记.md', mode: 'read' }
  await first.write(first.key('/my-notes'), session)
  assert.deepEqual(await first.load('/my-notes'), session)
  const timestamp = (await first.save('/my-notes', session))[0].checkedAt
  assert.ok(Number.isFinite(Date.parse(timestamp)))
  assert.equal((await first.save('/my-notes', session))[0].checkedAt, timestamp)
  await first.save('/other-notes', { tabs: [], mode: 'split' })
  const second = new LocalState(dir)
  assert.equal(await second.recent(), '/my-notes')
  assert.deepEqual(await second.load('/my-notes'), { ...session, tabs: [{ path: '笔记.md', draft: { ...draft, checkedAt: timestamp } }] })
  assert.deepEqual((await second.load('/other-notes')).tabs, [])
  const baseline = '# 磁盘原稿'
  await second.save('/my-notes', { ...session, tabs: [...session.tabs, { path: '其他.md', draft: { ...draft, baseline } }] })
  await second.save('/my-notes', { ...session, tabs: (await second.load('/my-notes')).tabs.slice(1) })
  assert.equal((await second.load('/my-notes')).tabs[0].draft.baseline, baseline)
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
  const styled = "\uFEFF--- \r\n# 首行\r\ntitle: 'old' # 标题\r\nauthor: |\r\n  Zoe\r\ntags:\r\n  - 'one' # 保留\r\n  - two\r\ncreated: 2024-01-01\r\nmodified: \"old\" # 更新时间\r\n... \r\n# 正文\r\n"
  const expected = styled.replace("'old'", "'新标题'").replace("'one'", "'first'").replace('- two', '- 中文')
  assert.equal(updateInfo(styled, '新标题', ['first', '中文']), expected)
  assert.equal(touchNote(expected, 'now'), expected.replace('"old"', '"now"'))
  assert.equal(updateInfo('---\r\n# comment\r\n---\r\nBody', '新增', ['标签']),
    '---\r\n# comment\r\ntitle: "新增"\r\ntags: ["标签"]\r\n---\r\nBody')
  assert.throws(() => updateInfo('---\ntitle: A\ntitle: B\n---\n', 'C', []), /YAML/)
})
