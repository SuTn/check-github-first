import test from 'node:test'
import assert from 'node:assert/strict'
import {
  significantTerms,
  planQueries,
  filterSuffix,
  preciseRelaxedQuery,
  readmeRecallQuery,
} from '../src/plan.mjs'

test('中文整句保持一个带引号的 CJK 词（结构，不做语义翻译）', () => {
  const terms = significantTerms('一个支持全文搜索的文档站点生成器')
  assert.equal(terms.length, 1)
  assert.equal(terms[0].kind, 'cjk')
  assert.equal(terms[0].term, '"一个支持全文搜索的文档站点生成器"')
})

test('拉丁词小写、去重、过滤停用词与单字符', () => {
  const terms = significantTerms('Local-first Note Taking a of the')
  assert.deepEqual(terms.map((t) => t.term), ['local-first', 'note', 'taking'])
  assert.ok(terms.every((t) => t.kind === 'latin'))
})

test('两个拉丁词：anchor + tail，不生成 precise（三通道宣称的边界）', () => {
  const steps = planQueries(['local-first', 'note-taking'], {})
  assert.deepEqual(steps.map((s) => s.role), ['anchor', 'tail'])
  assert.equal(steps[1].sort, 'updated')
})

test('三个以上拉丁词：anchor + precise + tail，tail 用 precise 词', () => {
  const steps = planQueries(['photo', 'backup', 'organizer'], {})
  assert.deepEqual(steps.map((s) => s.role), ['anchor', 'precise', 'tail'])
  assert.equal(steps[1].query, 'photo backup organizer')
  assert.equal(steps[2].query, 'photo backup organizer')
  assert.equal(steps[2].sort, 'updated')
})

test('只有锚点 topics 没有拉丁词：单条 topic: 查询', () => {
  const steps = planQueries([], { anchorTopics: ['note-taking', 'markdown'] })
  assert.equal(steps.length, 1)
  assert.equal(steps[0].role, 'anchor')
  assert.ok(steps[0].query.startsWith('topic:'))
})

test('锚点 topics 按检索词相关性排序，实现/部署技术词降权', () => {
  const steps = planQueries(['note-taking'], { anchorTopics: ['docker', 'clojure', 'note-taking', 'markdown'] })
  assert.ok(steps[0].query.startsWith('topic:note-taking'))
  assert.ok(!steps[0].query.includes('topic:docker'))
})

test('filterSuffix 全量传导硬约束', () => {
  const suffix = filterSuffix({ lang: 'typescript', license: 'mit', minStars: 100, active: true })
  assert.match(suffix, /language:typescript/)
  assert.match(suffix, /license:mit/)
  assert.match(suffix, /stars:>100/)
  assert.match(suffix, /pushed:>\d{4}-\d{2}-\d{2}/)
  assert.match(suffix, /archived:false/)
})

test('preciseRelaxedQuery：少于 4 词返回 null，否则用第 3、4 词', () => {
  assert.equal(preciseRelaxedQuery(['a', 'b', 'c'], {}), null)
  assert.equal(preciseRelaxedQuery(['a', 'b', 'c', 'd'], {}), 'c d')
})

test('preciseRelaxedQuery 跳过已执行查询（不浪费配额）', () => {
  assert.equal(preciseRelaxedQuery(['a', 'b', 'c', 'd'], {}, ['c d']), null)
})

test('readmeRecallQuery 带引号短语 + in:readme + 硬约束', () => {
  const q = readmeRecallQuery(['local first', 'note'], { lang: 'typescript', minStars: 10 })
  assert.match(q, /^"local first note" in:readme/)
  assert.match(q, /language:typescript/)
  assert.match(q, /stars:>10/)
  assert.match(q, /fork:false archived:false/)
})
