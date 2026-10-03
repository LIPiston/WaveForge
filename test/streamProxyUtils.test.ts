import { describe, expect, it, vi } from 'vitest'
import { parseByteRange, fetchStreamWithIdleTimeout, StreamProxyError } from '../server/stream-proxy-utils.mjs'

async function readAll(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

/** 造一个可控的 web ReadableStream：逐块吐出，块之间可以卡住 */
function controlledBody(chunks, { stallAt = null } = {}) {
  let index = 0
  let resolveStall = null
  const stream = new ReadableStream({
    pull(controller) {
      if (stallAt !== null && index === stallAt) {
        // 卡住：不 enqueue 也不 close，模拟上游握手成功后再无数据
        return new Promise(resolve => { resolveStall = resolve })
      }
      if (index >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(chunks[index])
      index += 1
      void resolveStall
    },
  })
  return { stream, release: () => resolveStall?.() }
}

const okHeaders = { 'content-type': 'audio/mpeg' }

describe('parseByteRange', () => {
  it('解析闭区间并按总长收敛 end', () => {
    expect(parseByteRange('bytes=0-499', 1000)).toEqual({ start: 0, end: 499 })
    expect(parseByteRange('bytes=100-2000', 1000)).toEqual({ start: 100, end: 999 })
  })

  it('解析开区间 bytes=a-', () => {
    expect(parseByteRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 })
  })

  it('解析后缀区间 bytes=-N 为「最后 N 字节」', () => {
    // 这正是旧就地实现搞错的形式：它把 bytes=-500 当成 0-500，取到了开头
    expect(parseByteRange('bytes=-500', 1000)).toEqual({ start: 500, end: 999 })
    expect(parseByteRange('bytes=-2000', 1000)).toEqual({ start: 0, end: 999 })
    expect(parseByteRange('bytes=-1', 1000)).toEqual({ start: 999, end: 999 })
  })

  it('越界区间报 unsatisfiable', () => {
    expect(parseByteRange('bytes=1000-', 1000)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=2000-3000', 1000)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=-0', 1000)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=0-', 0)).toBe('unsatisfiable')
  })

  it('无 Range / 语法非法 / 多段范围一律按全量处理（返回 null）', () => {
    expect(parseByteRange(undefined, 1000)).toBeNull()
    expect(parseByteRange('', 1000)).toBeNull()
    expect(parseByteRange('items=0-10', 1000)).toBeNull()
    expect(parseByteRange('bytes=abc', 1000)).toBeNull()
    expect(parseByteRange('bytes=-', 1000)).toBeNull()
    // 多段范围本实现不支持：HTTP 允许忽略 Range 并回 200 全量
    expect(parseByteRange('bytes=0-1,5-6', 1000)).toBeNull()
  })

  it('end 小于 start 报 unsatisfiable', () => {
    expect(parseByteRange('bytes=500-100', 1000)).toBe('unsatisfiable')
  })
})

describe('fetchStreamWithIdleTimeout', () => {
  it('正常流按块透传，不改变字节内容', async () => {
    const { stream } = controlledBody([Buffer.from('abc'), Buffer.from('def')])
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 206, headers: okHeaders }))
    const { response, stream: guarded } = await fetchStreamWithIdleTimeout('https://cdn.example/a.mp3', { fetchImpl })
    expect(response.status).toBe(206)
    expect((await readAll(guarded)).toString()).toBe('abcdef')
  })

  it('等待响应头超时抛 504', async () => {
    const fetchImpl = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    }))
    await expect(
      fetchStreamWithIdleTimeout('https://cdn.example/a.mp3', { fetchImpl, headerTimeoutMs: 10 }),
    ).rejects.toMatchObject({ name: 'StreamProxyError', status: 504 })
  })

  it('流中途卡死触发空闲超时，已发出的数据不受影响', async () => {
    // 第 2 块（index=1）开始卡住
    const { stream } = controlledBody([Buffer.from('first')], { stallAt: 1 })
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200, headers: okHeaders }))
    const { stream: guarded } = await fetchStreamWithIdleTimeout('https://cdn.example/a.mp3', {
      fetchImpl,
      idleTimeoutMs: 20,
    })
    await expect(readAll(guarded)).rejects.toMatchObject({ status: 504 })
  })

  it('慢速但持续推进的流不会因总体耗时超时而中断', async () => {
    // 三块之间各等 30ms，总耗时 90ms 远超空闲超时的 40ms 间隔判定，
    // 但每块间隔 < idleTimeoutMs，所以必须全部读完
    const chunks = [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')]
    let index = 0
    const stream = new ReadableStream({
      async pull(controller) {
        if (index >= chunks.length) {
          controller.close()
          return
        }
        await new Promise(resolve => setTimeout(resolve, 15))
        controller.enqueue(chunks[index])
        index += 1
      },
    })
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200, headers: okHeaders }))
    const { stream: guarded } = await fetchStreamWithIdleTimeout('https://cdn.example/a.mp3', {
      fetchImpl,
      idleTimeoutMs: 100,
    })
    expect((await readAll(guarded)).toString()).toBe('abc')
  })

  it('累计字节超过上限时中断', async () => {
    const { stream } = controlledBody([Buffer.alloc(8), Buffer.alloc(8)])
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200, headers: okHeaders }))
    const { stream: guarded } = await fetchStreamWithIdleTimeout('https://cdn.example/a.mp3', {
      fetchImpl,
      maxBytes: 10,
    })
    await expect(readAll(guarded)).rejects.toMatchObject({ status: 413 })
  })

  it('声明长度超过上限时在读取正文前直接抛 413', async () => {
    const { stream } = controlledBody([Buffer.alloc(4)])
    const fetchImpl = vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { ...okHeaders, 'content-length': '9999' },
    }))
    await expect(
      fetchStreamWithIdleTimeout('https://cdn.example/a.mp3', { fetchImpl, maxBytes: 100 }),
    ).rejects.toMatchObject({ status: 413 })
  })

  it('上游非 2xx 时把响应交回调用方，stream 为 null', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 403 }))
    const { response, stream } = await fetchStreamWithIdleTimeout('https://cdn.example/a.mp3', { fetchImpl })
    expect(response.status).toBe(403)
    expect(stream).toBeNull()
  })

  it('网络层失败映射为 502', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNRESET') })
    await expect(
      fetchStreamWithIdleTimeout('https://cdn.example/a.mp3', { fetchImpl }),
    ).rejects.toMatchObject({ status: 502 })
  })

  it('外部 signal 中止时立即停止', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    }))
    const pending = fetchStreamWithIdleTimeout('https://cdn.example/a.mp3', {
      fetchImpl,
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(StreamProxyError)
  })

  it('消费方 destroy 会取消上游 reader', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(Buffer.alloc(4)) },
      cancel,
    })
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200, headers: okHeaders }))
    const { stream: guarded } = await fetchStreamWithIdleTimeout('https://cdn.example/a.mp3', { fetchImpl })
    guarded.destroy()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(cancel).toHaveBeenCalled()
  })

  it('校验超时与上限参数', async () => {
    await expect(
      fetchStreamWithIdleTimeout('https://cdn.example/a.mp3', { idleTimeoutMs: 0 }),
    ).rejects.toThrow(/idleTimeoutMs/)
  })
})
