import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import { registerSodaAudioProxy } from '../server/qishui-audio-decryptor.mjs'

/**
 * 汽水缓存管理路由的契约。
 * 前端 services/serverCacheAdmin.ts 依赖这些路径，改名会静默让「清理缓存」失效，
 * 因此在这里钉住路由存在性与响应形状（缓存内容本身由 boundedAsyncCache.test.ts 覆盖）。
 */

let server: import('node:http').Server
let base = ''

beforeAll(async () => {
  const app = express()
  registerSodaAudioProxy(app)
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('failed to bind test server')
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => { server.close(() => resolve()) })
})

describe('汽水缓存管理路由', () => {
  it('POST /api/cache/soda/clear 返回清理结果', async () => {
    const response = await fetch(`${base}/api/cache/soda/clear`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, cleared: 0, freedBytes: 0 })
  })

  it('GET /api/cache/soda/stats 返回容量配置', async () => {
    const response = await fetch(`${base}/api/cache/soda/stats`)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.success).toBe(true)
    expect(body.stats).toMatchObject({
      entries: 0,
      bytes: 0,
      maxEntries: 12,
      maxBytes: 256 * 1024 * 1024,
      inFlight: 0,
    })
  })

  it('解密代理路由仍挂在原路径上', async () => {
    // 缺参数应回 400 而不是 404：证明路由已注册
    const response = await fetch(`${base}/api/soda/audio`)
    expect(response.status).toBe(400)
  })
})
