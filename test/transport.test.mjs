import test from 'node:test'
import assert from 'node:assert/strict'
import { extractQueryTerms, contentsPath, matchTierOf } from '../src/transport.mjs'

test('过滤器值不再污染语义匹配词（旧版 license:mit → mit 命中 commit）', () => {
  const terms = extractQueryTerms(
    'local-first note-taking language:typescript license:mit stars:>100 pushed:>2026-05-09 archived:false fork:false in:readme'
  )
  assert.deepEqual(terms, ['local-first', 'note-taking'])
})

test('topic: 的值保留为语义词', () => {
  const terms = extractQueryTerms('topic:note-taking topic:markdown')
  assert.deepEqual(terms, ['note-taking', 'markdown'])
})

test('短于此前的 3 字符阈值与重复词被丢弃', () => {
  assert.deepEqual(extractQueryTerms('a ab abc ABC abc'), ['abc'])
})

test('contentsPath：无 ref/HEAD 时不拼 ?ref=undefined（匿名深读 500 的根因）', () => {
  assert.equal(contentsPath('o', 'r', 'README.md'), '/repos/o/r/contents/README.md')
  assert.equal(contentsPath('o', 'r', 'README.md', 'HEAD'), '/repos/o/r/contents/README.md')
  assert.equal(contentsPath('o', 'r', 'README.md', 'main'), '/repos/o/r/contents/README.md?ref=main')
})

test('contentsPath 对路径每段编码', () => {
  assert.equal(
    contentsPath('o', 'r', 'apps/my app/package.json'),
    '/repos/o/r/contents/apps/my%20app/package.json'
  )
})

test('matchTierOf：topics > name > description > 无', () => {
  const q = ['notes']
  assert.equal(matchTierOf('x/y', 'desc notes', ['notes'], q), 3)
  assert.equal(matchTierOf('notes-app', '', [], q), 2)
  assert.equal(matchTierOf('x/y', 'a notes app', [], q), 1)
  assert.equal(matchTierOf('x/y', 'unrelated', [], q), 0)
  assert.equal(matchTierOf('x/y', 'a notes app', ['notes'], []), 0)
})
