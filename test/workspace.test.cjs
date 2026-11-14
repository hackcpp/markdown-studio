const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { Workspace } = require('../electron/workspace.cjs')

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-studio-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return Workspace.open(root)
}

test('扫描多级目录，移动文件夹，不覆盖同名笔记', async t => {
  const ws = await fixture(t)
  await ws.create('', '课程', true)
  await ws.create('课程', '算法', true)
  const note = await ws.create('课程/算法', '入门', false)
  await ws.create('', '归档', true)
  assert.equal((await ws.tree()).find(node => node.path === '课程').children[0].children[0].path, note)
  await assert.rejects(ws.create('课程/算法', '入门', false), { code: 'EEXIST' })
  await assert.rejects(ws.move('课程', '课程/算法', '课程'), /下级/)
  assert.equal(await ws.move('课程/算法', '归档', '算法'), '归档/算法')
  assert.equal(await ws.move('归档/算法/入门.md', '归档/算法', '概览'), '归档/算法/概览.md')
  assert.equal(await ws.read(note), null)
  assert.equal((await ws.read('归档/算法/概览.md')).content, '')
  await ws.create('', '概览.md', false)
  await assert.rejects(ws.move('归档/算法/概览.md', '', '概览'), /同名/)
})

test('外部修改保留磁盘版本并拒绝过期覆盖', async t => {
  const ws = await fixture(t)
  const note = await ws.create('', 'Note', false)
  const base = await ws.read(note)
  const file = path.join(ws.root, note)
  await fs.writeFile(file, 'external\r\n')
  const conflict = await ws.save(note, 'draft', base.hash)
  assert.equal(conflict.conflict, true)
  assert.equal(conflict.disk.content, 'external\r\n')
  await fs.writeFile(file, 'newer\r\n')
  assert.equal((await ws.save(note, 'draft', conflict.disk.hash, assert.fail)).conflict, true)
  let backup
  const current = await ws.read(note)
  const saved = await ws.save(note, 'draft\nsecond\n', current.hash, async disk => { backup = disk })
  assert.equal(saved.conflict, false)
  assert.equal(backup, 'newer\r\n')
  assert.equal(await fs.readFile(file, 'utf8'), 'draft\r\nsecond\r\n')
})

test('移动笔记更新本地图片引用，保留代码和外部链接以及废纸篓操作后的附件', async t => {
  const ws = await fixture(t)
  const note = await ws.create('', 'Note', false)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr6kAAAAASUVORK5CYII=', 'base64')
  const image = await ws.paste(note, png)
  const link = '![](' + image + ')'
  const disk = await ws.read(note)
  await ws.save(note, link + '\n\n```md\n' + link + '\n```\n\n![手写](picture.png) ![外部](https://example.org/picture.png)', disk.hash)
  await ws.create('', 'Archive', true)
  const moved = await ws.move(note, 'Archive', 'Note')
  assert.equal((await ws.read(moved)).content,
    '![](../' + image + ')\n\n```md\n' + link + '\n```\n\n![手写](../picture.png) ![外部](https://example.org/picture.png)')
  await ws.trash(moved, async file => {
    assert.equal(file, path.join(ws.root, moved))
    await fs.rename(file, path.join(ws.root, '.test-trash'))
  })
  assert.equal(await ws.read(moved), null)
  assert.deepEqual(await fs.readFile((await ws.image(image)).file), png)
})

test('重命名目录更新反向引用，以及被草稿引用时暂停', async t => {
  const ws = await fixture(t)
  await ws.create('', '资料 夹', true)
  const note = await ws.create('资料 夹', '中文', false)
  const reference = await ws.create('', '入口', false, '[笔记][ref]\n\n[ref]: <资料 夹/中文.md?x=1#段落> "说明"\n')
  await assert.rejects(ws.move('资料 夹', '', '新 目录', [{ path: reference, text: '' }]), /入口/)
  assert.ok(await ws.read(note))
  await ws.move('资料 夹', '', '新 目录')
  assert.equal((await ws.read(reference)).content, '[笔记][ref]\n\n[ref]: <新 目录/中文.md?x=1#段落> "说明"\n')
  const before = await ws.read('新 目录/中文.md')
  if (before.identity) {
    await fs.rename(path.join(ws.root, '新 目录/中文.md'), path.join(ws.root, '外部移动.md'))
    assert.equal(await ws.movedNote('新 目录/中文.md', before.identity, before.hash), '外部移动.md')
    await fs.writeFile(path.join(ws.root, '外部移动.md'), '磁盘已变')
    assert.equal(await ws.movedNote('新 目录/中文.md', before.identity, before.hash), null)
  }
})

test('目录废纸篓预览包含隐藏项并要求重新确认变化后的清单', async t => {
  const ws = await fixture(t)
  await ws.create('', 'Folder', true)
  const empty = await ws.trashPreview('Folder')
  assert.deepEqual([empty.files, empty.directories], [0, 0])
  await fs.mkdir(path.join(ws.root, 'Folder', '.hidden'))
  await fs.writeFile(path.join(ws.root, 'Folder', '.hidden', '.asset'), 'asset')
  const updated = await ws.trash('Folder', assert.fail, empty.signature)
  assert.deepEqual([updated.files, updated.directories], [1, 1])
  let called = false
  assert.equal(await ws.trash('Folder', () => { called = true }, updated.signature), null)
  assert.ok(called)
})

test('拒绝工作区外路径和符号链接', async t => {
  const ws = await fixture(t)
  await fs.symlink(os.tmpdir(), path.join(ws.root, 'external'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.deepEqual(await ws.tree(), [])
  await assert.rejects(ws.create('external', 'unsafe', false), /符号链接/)
  await assert.rejects(ws.read('../unsafe.md'), /无效/)
})
