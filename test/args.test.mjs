import test from 'node:test'
import assert from 'node:assert/strict'
import { ArgError, parseArgs } from '../src/args.mjs'

test('位置参数可以出现在 flag 之后（旧版遇 - 就 break 的回归）', () => {
  const cli = parseArgs(['--quick', '本地优先的笔记应用'])
  assert.equal(cli.mode, 'search')
  assert.equal(cli.idea, '本地优先的笔记应用')
  assert.equal(cli.flags.quick, true)
})

test('位置参数可以出现在 flag 之前', () => {
  const cli = parseArgs(['本地优先的笔记应用', '--keywords', 'local-first note-taking'])
  assert.equal(cli.idea, '本地优先的笔记应用')
  assert.equal(cli.values.keywords, 'local-first note-taking')
})

test('支持 --flag=value', () => {
  const cli = parseArgs(['想法', '--min-stars=100', '--lang=typescript'])
  assert.equal(cli.values.minStars, 100)
  assert.equal(cli.values.lang, 'typescript')
})

test('--min-stars 缺值/非法值报 ArgError（不再静默变 0）', () => {
  assert.throws(() => parseArgs(['想法', '--min-stars']), ArgError)
  assert.throws(() => parseArgs(['想法', '--min-stars', 'abc']), ArgError)
  assert.throws(() => parseArgs(['想法', '--min-stars', '-1']), ArgError)
})

test('未知参数报 ArgError', () => {
  assert.throws(() => parseArgs(['想法', '--nope']), ArgError)
})

test('--inspect 收集 repos 并校验 owner/repo', () => {
  const cli = parseArgs(['--inspect', 'a/b', 'c/d'])
  assert.equal(cli.mode, 'inspect')
  assert.deepEqual(cli.repos, ['a/b', 'c/d'])
  assert.throws(() => parseArgs(['--inspect', 'nope']), ArgError)
  assert.throws(() => parseArgs(['--inspect']), ArgError)
})

test('--probe 需要 owner/repo', () => {
  const cli = parseArgs(['--probe', 'logseq/logseq'])
  assert.equal(cli.mode, 'probe')
  assert.equal(cli.values.probe, 'logseq/logseq')
  assert.throws(() => parseArgs(['--probe', 'nope']), ArgError)
})

test('--help/--version 优先且不需要想法', () => {
  assert.equal(parseArgs(['--help']).mode, 'help')
  assert.equal(parseArgs(['-h']).mode, 'help')
  assert.equal(parseArgs(['--version']).mode, 'version')
  assert.throws(() => parseArgs([]), ArgError)
})

test('-- 之后全部视为位置参数', () => {
  const cli = parseArgs(['--keywords', 'a b', '--', '--weird'])
  assert.equal(cli.idea, '--weird')
})
