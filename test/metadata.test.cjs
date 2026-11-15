const { test } = require('node:test')
const assert = require('node:assert/strict')
const { touchNote, noteInfo, updateInfo } = require('../electron/metadata.cjs')

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
