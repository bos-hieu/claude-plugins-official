import { expect, test } from 'bun:test'
import { encodeFrame, LineDecoder, type BrokerFrame } from './ipc'

test('encodeFrame is newline-terminated JSON', () => {
  const s = encodeFrame({ t: 'heartbeat' })
  expect(s.endsWith('\n')).toBe(true)
  expect(JSON.parse(s)).toEqual({ t: 'heartbeat' })
})

test('LineDecoder reassembles frames split across chunks', () => {
  const got: BrokerFrame[] = []
  const d = new LineDecoder<BrokerFrame>(f => got.push(f))
  d.push(Buffer.from('{"t":"welcome","bot_username":"b","chat_id":"1"}\n{"t":"in'))
  d.push(Buffer.from('bound","content":"hi","meta":{}}\n'))
  expect(got.length).toBe(2)
  expect(got[0].t).toBe('welcome')
  expect(got[1].t).toBe('inbound')
})

test('LineDecoder ignores blank lines', () => {
  const got: BrokerFrame[] = []
  const d = new LineDecoder<BrokerFrame>(f => got.push(f))
  d.push(Buffer.from('\n\n{"t":"heartbeat"}\n'))
  expect(got.length).toBe(1)
})

test('LineDecoder preserves multi-byte UTF-8 split across chunks', () => {
  const got: any[] = []
  const d = new LineDecoder<any>(f => got.push(f))
  const full = Buffer.from(JSON.stringify({ t: 'inbound', content: 'héllo 🎉 日本語', meta: {} }) + '\n', 'utf8')
  const mid = Math.floor(full.length / 2)
  d.push(full.subarray(0, mid))
  d.push(full.subarray(mid))
  expect(got.length).toBe(1)
  expect(got[0].content).toBe('héllo 🎉 日本語')
})
