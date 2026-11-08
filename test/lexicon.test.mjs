import test from 'node:test'
import assert from 'node:assert/strict'
import { LEXICON, KNOWN_PRODUCTS, lexiconLookup } from '../src/lexicon.mjs'

test('词典词条数为 99（删除死键后；文档须与此一致）', () => {
  assert.equal(Object.keys(LEXICON).length, 99)
})

test('没有带前导/尾随空格的死键（旧版 " rss" 永远匹配不到）', () => {
  for (const k of Object.keys(LEXICON)) {
    assert.equal(k, k.trim(), `词条 "${k}" 含多余空格`)
  }
})

test('精确命中优先', () => {
  assert.equal(LEXICON['文档站'], 'documentation site')
  assert.equal(LEXICON['rss阅读器'], 'rss reader')
})

test('子串命中并去冗余（短词是长词子串时不重复输出）', () => {
  const { hits } = lexiconLookup(['智能分类整理'])
  assert.deepEqual(hits, ['auto classification'])
})

test('多词命中按中文词条长度降序、去重', () => {
  const { hits, misses } = lexiconLookup(['文档站', '全文搜索', '不存在的词'])
  assert.ok(hits.includes('documentation site'))
  assert.ok(hits.includes('full-text search'))
  assert.deepEqual(misses, ['不存在的词'])
  assert.deepEqual(hits, [...new Set(hits)])
})

test('引号包裹的中文片段也能命中', () => {
  const { hits } = lexiconLookup(['"本地优先"'])
  assert.deepEqual(hits, ['local-first'])
})

test('已知产品集合非空且全小写', () => {
  assert.ok(KNOWN_PRODUCTS.size > 0)
  for (const p of KNOWN_PRODUCTS) assert.equal(p, p.toLowerCase())
})
