import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeProxy, detectProxy, resetProxyCache } from '../src/net.mjs'

test('裸 host:port 补 http://', () => {
  assert.equal(normalizeProxy('127.0.0.1:7890'), 'http://127.0.0.1:7890')
})

test('http(s) URL 原样保留并去掉尾部斜杠', () => {
  assert.equal(normalizeProxy('http://proxy.local:8080/'), 'http://proxy.local:8080')
  assert.equal(normalizeProxy('https://user:pass@proxy.local:443'), 'https://user:pass@proxy.local')
})

test('非 HTTP(S) 协议返回 null（旧版会拼成 http://socks5://…）', () => {
  assert.equal(normalizeProxy('socks5://127.0.0.1:1080'), null)
  assert.equal(normalizeProxy('socks://127.0.0.1:1080'), null)
})

test('空值返回 null', () => {
  assert.equal(normalizeProxy(''), null)
  assert.equal(normalizeProxy(null), null)
  assert.equal(normalizeProxy('   '), null)
})

test('环境变量代理参与探测且可重复重置', () => {
  const old = process.env.HTTP_PROXY
  process.env.HTTP_PROXY = 'http://127.0.0.1:4321'
  resetProxyCache()
  assert.equal(detectProxy(), 'http://127.0.0.1:4321')
  if (old === undefined) delete process.env.HTTP_PROXY
  else process.env.HTTP_PROXY = old
  resetProxyCache()
})
