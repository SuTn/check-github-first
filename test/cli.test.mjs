import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// 极少数受限环境禁止 spawn 子进程（node --test 的默认隔离模式同样会因此失败）。
// 用同一调用形态探测一次，失败则整组跳过，而不是让 npm test 红着。
const probe = spawnSync(process.execPath, ['scout.mjs', '--version'], { cwd: root, encoding: 'utf8' })
const skip = probe.error ? `当前环境禁止 spawn 子进程（${probe.error.code}）` : false

const run = (...args) =>
  spawnSync(process.execPath, ['scout.mjs', ...args], { cwd: root, encoding: 'utf8' })

test('--version 输出版本号且 exit 0（不依赖网络）', { skip }, () => {
  const r = run('--version')
  assert.equal(r.status, 0)
  assert.equal(r.stdout.trim(), pkg.version)
})

test('--help 输出用法且 exit 0', { skip }, () => {
  const r = run('--help')
  assert.equal(r.status, 0)
  assert.match(r.stdout, /用法:/)
  assert.match(r.stdout, /--inspect/)
})

test('未知参数/缺少想法：参数错误 exit 1，不打印 Node 堆栈', { skip }, () => {
  for (const args of [['--nope'], []]) {
    const r = run(...args)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /参数错误/)
    assert.doesNotMatch(r.stderr, /at .*\.mjs:/)
  }
})

test('--quick 放在想法之前也能解析（旧版 bug：idea 为空）', { skip }, () => {
  // 只验证解析层面：用一个词典完全未命中的想法，应快速 exit 2 而不是报用法
  const r = run('--quick', '一个没有词典命中的想法')
  assert.equal(r.status, 2)
  assert.match(r.stderr, /--keywords/)
})

test('--inspect 参数非法时 exit 1', { skip }, () => {
  const r = run('--inspect', 'not-a-repo')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /owner\/repo/)
})
