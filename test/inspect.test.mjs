import test from 'node:test'
import assert from 'node:assert/strict'
import { pickFiles, pickMonorepoManifest, MANIFESTS } from '../src/inspect.mjs'

const tree = (...paths) => paths.map((path) => ({ path, type: 'blob' }))

test('Rust 仓库：Cargo.toml 必须选中（旧版大小写敏感永远选不中）', () => {
  const files = pickFiles(tree('Cargo.toml', 'src/main.rs', 'README.md'))
  assert.equal(files[0].path, 'Cargo.toml')
  assert.equal(files[0].why, 'manifest（技术栈与依赖）')
  assert.equal(files[1].path, 'src/main.rs')
})

test('Ruby 仓库：Gemfile 必须选中', () => {
  const files = pickFiles(tree('Gemfile', 'config.ru', 'README.md'))
  assert.equal(files[0].path, 'Gemfile')
})

test('Node 仓库：package.json + 入口文件', () => {
  const files = pickFiles(tree('package.json', 'src/index.ts', 'README.md'))
  assert.deepEqual(files.map((f) => f.path), ['package.json', 'src/index.ts'])
})

test('没有 manifest 时回退 README，且最多 2 个文件', () => {
  const files = pickFiles(tree('docs/x.md', 'README.md', 'main.py', 'server.go'))
  assert.ok(files.length <= 2)
  assert.equal(files[0].path, 'main.py')
  assert.equal(files[1].path, 'README.md')
})

test('子目录 manifest 也能命中（monorepo/嵌套包）', () => {
  const files = pickFiles(tree('website/Cargo.toml', 'src/lib.rs'))
  assert.equal(files[0].path, 'website/Cargo.toml')
})

test('MANIFESTS 表全部小写（用大小写不敏感比较）', () => {
  for (const m of MANIFESTS) assert.equal(m, m.toLowerCase())
})

test('monorepo 嗅探优先 apps/web 等常见子包，其次任意子包', () => {
  assert.equal(
    pickMonorepoManifest(tree('apps/api/package.json', 'apps/web/package.json')),
    'apps/web/package.json'
  )
  assert.equal(pickMonorepoManifest(tree('packages/core/package.json')), 'packages/core/package.json')
  assert.equal(pickMonorepoManifest(tree('package.json')), null)
})
