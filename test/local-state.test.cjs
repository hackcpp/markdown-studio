const { test } = require('node:test')
const assert = require('node:assert/strict')
const { tempDirectory } = require('./helpers/temp-directory.cjs')
const { LocalState } = require('../electron/local-state.cjs')

test('恢复文件保留原基准哈希并按工作区隔离', async t => {
  const dir = await tempDirectory(t)
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
