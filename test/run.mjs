// test/run.mjs — 在同一进程内运行全部测试文件。
//
// 为什么不用 `node --test` 默认模式：它每個文件 spawn 一个子进程，部分受限
// 环境（沙箱/CI 容器）禁止 spawn，会整体报 EPERM。这里直接 import，node:test
// 仍按文件/用例汇总输出与退出码。CI 上也可直接跑 `node --test`。
import './args.test.mjs'
import './plan.test.mjs'
import './lexicon.test.mjs'
import './net.test.mjs'
import './transport.test.mjs'
import './inspect.test.mjs'
import './card.test.mjs'
import './cli.test.mjs'
