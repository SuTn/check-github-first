import test from 'node:test'
import assert from 'node:assert/strict'
import { pickFiles, pickMonorepoManifest, treeScopeNote, inspectRepo, MANIFESTS } from '../src/inspect.mjs'

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

test('vendor 目录里的 manifest 不抢根 manifest（nodejs/node 教训）', () => {
  // nodejs/node：根级 pyproject.toml + deps/ 下 201 个 vendor package.json
  const files = pickFiles(tree(
    'deps/acorn/acorn-walk/package.json',
    'deps/v8/package.json',
    'benchmark/napi/buffer/index.js',
    'pyproject.toml',
    'src/node_main.cc',
    'README.md',
  ))
  assert.equal(files[0].path, 'pyproject.toml')
  // vendor 里的入口文件也不选
  assert.notEqual(files[1]?.path, 'benchmark/napi/buffer/index.js')
})

test('嵌套 vendor 段也排除（test/addons/.../node_modules fixture）', () => {
  // 实测 nodejs/node 首中 test/addons/esm/node_modules/esm-package/package.json
  const files = pickFiles(tree(
    'test/addons/esm/node_modules/esm-package/package.json',
    'pyproject.toml',
    'README.md',
  ))
  assert.equal(files[0].path, 'pyproject.toml')
})

test('根级优先于 MANIFESTS 顺序（根 pyproject.toml 必须赢 tools/ 嵌套 package.json）', () => {
  // 实测 nodejs/node 第二轮教训：tools/clang-format/package.json 抢了根 pyproject.toml
  const files = pickFiles(tree(
    'tools/clang-format/package.json',
    'pyproject.toml',
    'lib/internal/bench_runner/cli.js',
  ))
  assert.equal(files[0].path, 'pyproject.toml')
})

test('根级 package.json 优先于 deps 里别的 manifest', () => {
  const files = pickFiles(tree(
    'deps/openssl/package.json',
    'package.json',
    'src/index.ts',
  ))
  assert.equal(files[0].path, 'package.json')
})

test('入口文件浅层优先（lib/cli.js 赢 lib/internal/bench_runner/cli.js）', () => {
  const files = pickFiles(tree(
    'lib/internal/bench_runner/cli.js',
    'lib/cli.js',
    'package.json',
  ))
  assert.equal(files[1].path, 'lib/cli.js')
})

test('根没有任何 manifest 时，非 vendor 子目录 manifest 仍可命中', () => {
  const files = pickFiles(tree('deps/x/package.json', 'apps/server/go.mod'))
  assert.equal(files[0].path, 'apps/server/go.mod')
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

test('treeScopeNote：MCP 根目录兜底必须标注，不冒充全树（nodejs/node 51 项假树教训）', () => {
  const full = [{ path: 'a' }]
  full.truncated = false
  full.rootOnly = false
  assert.equal(treeScopeNote(full), '')
  assert.equal(treeScopeNote([{ path: 'a' }]), '')
  const apiTruncated = [{ path: 'a' }]
  apiTruncated.truncated = true
  assert.match(treeScopeNote(apiTruncated), /GitHub 返回截断/)
  const rootOnlyTree = [{ path: 'a' }]
  rootOnlyTree.truncated = true
  rootOnlyTree.rootOnly = true
  assert.match(treeScopeNote(rootOnlyTree), /仅根目录一层/)
})

test('inspectRepo 渲染 rootOnly 假树：标注进卡片 + 请求预算照常', async () => {
  // 模拟 nodejs/node 树超时 → MCP 根目录兜底（51 项）
  const fakeTree = [
    { path: 'pyproject.toml', type: 'blob' },
    { path: 'README.md', type: 'blob' },
    { path: 'deps', type: 'tree' },
  ]
  fakeTree.truncated = true
  fakeTree.rootOnly = true
  fakeTree.requests = 1
  const dep = {
    getTree: async () => fakeTree,
    getFile: async (o, r, p) => ({ text: p.endsWith('README') ? '# Node.js\nruntime' : '[tool.ruff]\nexclude', ok: true }),
  }
  const card = await inspectRepo('nodejs/node', 4, dep)
  assert.equal(card.ok, true)
  assert.match(card.text, /目录规模: 3 项（仅根目录一层：REST 递归树超时\/不可用，MCP 兜底只列了根）/)
  assert.match(card.text, /技术栈（pyproject.toml）/)
  assert.match(card.text, /请求预算: 用了 3\/4/)
})
