'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const WebSocket = require('ws')
const { createDGLabRelay, rankInterfaces } = require('../server/dglab-relay.cjs')

const waitFor = async (predicate, timeoutMs = 1500) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition timed out')
}

const reservePort = () => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    server.close(error => error ? reject(error) : resolve(port))
  })
})

test('DG-LAB relay stays stopped until enabled and rejects unauthenticated control clients', async t => {
  const relay = createDGLabRelay()
  const port = await reservePort()
  relay._internal.settings.port = port
  t.after(() => relay.stop())

  assert.equal(relay.getStatus().running, false)
  assert.equal(relay._internal.server, null)

  relay.start()
  await waitFor(() => relay.getStatus().running)

  const unauthenticated = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/dglab/ctrl`)
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    socket.once('error', reject)
  })
  assert.deepEqual(unauthenticated, { code: 4003, reason: 'invalid control token' })

  const authenticated = new WebSocket(`ws://127.0.0.1:${port}/dglab/ctrl?token=${encodeURIComponent(relay._internal.controlToken)}`)
  await new Promise((resolve, reject) => {
    authenticated.once('open', resolve)
    authenticated.once('error', reject)
  })
  authenticated.close()

  relay.stop()
  await waitFor(() => !relay.getStatus().running)
  assert.equal(relay._internal.server, null)
})

test('DG-LAB relay rejects a mismatched V3 target', async t => {
  const relay = createDGLabRelay()
  const port = await reservePort()
  relay._internal.settings.port = port
  t.after(() => relay.stop())
  relay.start()
  await waitFor(() => relay.getStatus().running)

  const close = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/wrong-target`)
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    socket.once('error', reject)
  })
  assert.deepEqual(close, { code: 4003, reason: 'targetId mismatch' })
  assert.equal(relay._internal.app.v3, null)
})

test('DG-LAB relay ranks real NICs above virtual ones (case-insensitive)', () => {
  const nets = {
    'VMware Network Adapter VMnet1': [{ address: '192.168.174.1', family: 'IPv4', internal: false }],
    'Tailscale': [{ address: '100.121.183.34', family: 'IPv4', internal: false }],
    'vEthernet (Default Switch)': [{ address: '172.24.96.1', family: 'IPv4', internal: false }],
    'ZeroTier One [8056c2e21c000001]': [{ address: '172.25.10.5', family: 'IPv4', internal: false }],
    'Ethernet': [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
    'WLAN': [{ address: '192.168.88.44', family: 'IPv4', internal: false }],
  }
  const ranked = rankInterfaces(nets)
  // 默认扫码地址 = 无线网卡（用户选之前中继取列表第一个）
  assert.equal(ranked[0].address, '192.168.88.44')
  assert.equal(ranked[0].kind, 'wireless')
  // 实体网卡全部排在虚拟网卡之前
  const firstVirtual = ranked.findIndex(i => i.virtual)
  assert.ok(firstVirtual > 0)
  assert.ok(ranked.slice(0, firstVirtual).every(i => !i.virtual))
  assert.deepEqual(
    ranked.filter(i => i.virtual).map(i => i.address).sort(),
    ['100.121.183.34', '172.24.96.1', '172.25.10.5', '192.168.174.1'],
  )
  // 关键词大小写不敏感
  assert.equal(rankInterfaces({ TAILSCALE: [{ address: '100.64.0.9', family: 'IPv4', internal: false }] })[0].virtual, true)
  assert.equal(rankInterfaces({ vmware: [{ address: '192.168.174.1', family: 'IPv4', internal: false }] })[0].virtual, true)
  assert.equal(rankInterfaces({ ZEROTIER: [{ address: '10.147.17.5', family: 'IPv4', internal: false }] })[0].virtual, true)
  // 链路本地地址不参与，全被过滤时回退 localhost
  assert.equal(rankInterfaces({ Ethernet: [{ address: '169.254.1.1', family: 'IPv4', internal: false }] })[0].address, '127.0.0.1')
})
