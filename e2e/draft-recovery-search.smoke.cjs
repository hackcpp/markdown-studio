const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { _electron: electron } = require('playwright-core')
const { LocalState } = require('../electron/local-state.cjs')
const { Workspace } = require('../electron/workspace.cjs')
const { tempDirectory } = require('../test/helpers/temp-directory.cjs')

test('恢复草稿后可编辑，关闭保护生效，中文搜索定位到正文', { timeout: 90_000 }, async t => {
  let app
  const sandbox = await tempDirectory(t, async () => {
    if (!app) return
    const child = app.process()
    // 草稿故意保持未保存，退出测试实例时绕过原生关闭确认。
    try {
      await app.evaluate(({ app }) => { setImmediate(() => app.exit()) })
      await app.close()
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }
  })
  const notes = path.join(sandbox, 'notes')
  const profile = path.join(sandbox, 'profile')
  await fs.mkdir(notes)
  const workspace = await Workspace.open(notes)
  const original = '原始正文\n'
  const draft = '本地草稿\n'
  const file = await workspace.create('', '草稿', false, original)
  const base = await workspace.read(file)
  const match = '向量数据库'
  await workspace.create('', '搜索示例', false,
    Array.from({ length: 100 }, (_, index) => '普通段落 ' + index + '\n\n').join('') + '正文命中：' + match + '\n')
  await fs.writeFile(path.join(notes, file), '外部修改\n')
  const state = new LocalState(path.join(profile, 'sessions'))
  await state.remember(workspace.root)
  await state.save(workspace.root, {
    active: file,
    mode: 'source',
    tabs: [{ path: file, draft: { text: draft, base: base.hash, baseline: original } }]
  })

  const repo = path.resolve(__dirname, '..')
  app = await electron.launch({
    executablePath: process.env.STUDIO_ELECTRON ?? require('electron'),
    args: ['--user-data-dir=' + profile, repo],
    timeout: 30_000
  })
  const page = await app.firstWindow({ timeout: 15_000 })
  page.setDefaultTimeout(10_000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))

  const editor = page.locator('.editor:not([hidden]) .cm-content')
  await page.getByRole('button', { name: '恢复到编辑器', exact: true }).click()
  await page.getByText('磁盘版本已更改', { exact: true }).waitFor()
  await editor.getByText('本地草稿', { exact: true }).click()
  await page.keyboard.press('End')
  await page.keyboard.insertText('，继续编辑')
  await editor.getByText('本地草稿，继续编辑', { exact: true }).waitFor()

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+w' : 'Control+w')
  await page.locator('.error[role="alert"]').filter({ hasText: '关闭前请保存笔记或处理冲突' }).waitFor()
  await editor.getByText('本地草稿，继续编辑', { exact: true }).waitFor()
  assert.equal(await fs.readFile(path.join(notes, file), 'utf8'), '外部修改\n')

  await page.getByRole('button', { name: '搜索', exact: true }).click()
  const search = page.getByRole('dialog').getByRole('searchbox', { name: '搜索笔记' })
  await search.fill(match)
  await page.getByRole('button', { name: /搜索示例.*命中正文/ }).click()
  const hit = editor.locator('.cm-line.search-hit')
  await hit.filter({ hasText: '正文命中：' + match }).waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const pane = document.querySelector('.panes')
    const row = pane?.querySelector('.cm-line.search-hit')
    if (!pane?.scrollTop || !row) return false
    const bounds = pane.getBoundingClientRect()
    const line = row.getBoundingClientRect()
    return line.top >= bounds.top && line.bottom <= bounds.bottom
  })
  assert.equal(await hit.count(), 1)
  assert.deepEqual(errors, [])
})
