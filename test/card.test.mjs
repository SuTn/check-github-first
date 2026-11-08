import test from 'node:test'
import assert from 'node:assert/strict'
import { preScore, renderPool } from '../src/card.mjs'

const row = (over = {}) => ({
  full_name: 'o/r',
  stars: 100,
  pushed_at: new Date().toISOString(),
  language: 'TypeScript',
  description: 'desc',
  matchTier: 0,
  ...over,
})

test('预排序：同等热度/新鲜度下 tiers 越高分越高', () => {
  assert.ok(preScore(row({ matchTier: 3 })) > preScore(row({ matchTier: 0 })))
})

test('预排序：同 tier 下 star 多者分数高', () => {
  assert.ok(preScore(row({ stars: 1000 })) > preScore(row({ stars: 100 })))
})

test('预排序：pushed_at 缺失不抛异常（旧版 slice 崩溃点）', () => {
  assert.ok(Number.isFinite(preScore(row({ pushed_at: undefined }))))
})

test('卡片：8 列表头、行号连续、说明 final 由 agent 计算', () => {
  const rows = Array.from({ length: 3 }, (_, i) => row({ full_name: `o/r${i}` }))
  const text = renderPool([{ step: { role: 'anchor', query: 'x', sort: 'stars' }, rows, error: null }], {
    endpoint: 'rest-anon',
    terms: ['x'],
  })
  const header = text.split('\n').find((l) => l.startsWith('| # |'))
  assert.equal(header.split('|').length - 2, 8)
  assert.match(text, /relevance 由 agent 打分/)
  const nums = text.split('\n').filter((l) => /^\| \d+ \|/.test(l)).map((l) => Number(l.split('|')[1].trim()))
  assert.deepEqual(nums, [1, 2, 3])
})

test('卡片：通道失败时行数显示未知，不伪装成空结果', () => {
  const text = renderPool([{ step: { role: 'precise', query: 'q', sort: 'stars' }, rows: [], error: 'boom' }])
  assert.match(text, /行数未知/)
  assert.match(text, /boom/)
})
