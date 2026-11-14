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

test('移动笔记只更新受管理的图片引用，移入废纸篓入口后保留附件', async t => {
  const ws = await fixture(t)
  const note = await ws.create('', 'Note', false)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr6kAAAAASUVORK5CYII=', 'base64')
  const image = await ws.paste(note, png)
  const link = '![](' + image + ')'
  const disk = await ws.read(note)
  await ws.save(note, link + '\n\n```md\n' + link + '\n```\n\n![外部](picture.png)', disk.hash)
  await ws.create('', 'Archive', true)
  const moved = await ws.move(note, 'Archive', 'Note')
  assert.equal((await ws.read(moved)).content,
    '![](../' + image + ')\n\n```md\n' + link + '\n```\n\n![外部](picture.png)')
  await ws.trash(moved, async file => {
    assert.equal(file, path.join(ws.root, moved))
    await fs.rename(file, path.join(ws.root, '.test-trash'))
  })
  assert.equal(await ws.read(moved), null)
  assert.deepEqual(await fs.readFile((await ws.image(image)).file), png)
})

test('拒绝工作区外路径和符号链接', async t => {
  const ws = await fixture(t)
  await fs.symlink(os.tmpdir(), path.join(ws.root, 'external'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.deepEqual(await ws.tree(), [])
  await assert.rejects(ws.create('external', 'unsafe', false), /符号链接/)
  await assert.rejects(ws.read('../unsafe.md'), /无效/)
})
