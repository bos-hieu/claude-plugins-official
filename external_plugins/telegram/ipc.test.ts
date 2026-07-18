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
