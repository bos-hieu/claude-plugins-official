import { expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import net from 'net'
import { startBroker, deliverInbound } from './broker'
import { encodeFrame } from './ipc'

function connect(sock: string): Promise<net.Socket> {
  return new Promise((res, rej) => { const s = net.createConnection(sock, () => res(s)); s.on('error', rej) })
}

test('inbound topic message reaches the matching worker only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-route-'))
  const sock = join(dir, 'broker.sock')
  const broker = await startBroker({ sockPath: sock, poll: false })
  const w34 = await connect(sock)
  const got34: any[] = []
  w34.on('data', d => { for (const l of d.toString().split('\n')) if (l) { const f = JSON.parse(l); if (f.t === 'inbound') got34.push(f) } })
  w34.write(encodeFrame({ t: 'register', role: 'worker', topic_id: 34, pid: 1 }))
  await new Promise(r => setTimeout(r, 50))
  deliverInbound(broker, { chat_id: '-100', message_thread_id: '34', is_general: false }, 'hello 34', { thread_id: 34, is_private: false })
  await new Promise(r => setTimeout(r, 30))
  expect(got34.length).toBe(1)
  expect(got34[0].content).toBe('hello 34')
  await broker.stop()
})

test('unrouted topic falls back to hub with unrouted flag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-route-'))
  const sock = join(dir, 'broker.sock')
  const broker = await startBroker({ sockPath: sock, poll: false })
  const hub = await connect(sock)
  const gotHub: any[] = []
  hub.on('data', d => { for (const l of d.toString().split('\n')) if (l) { const f = JSON.parse(l); if (f.t === 'inbound') gotHub.push(f) } })
  hub.write(encodeFrame({ t: 'register', role: 'orchestrator', topic_id: null, pid: 1 }))
  await new Promise(r => setTimeout(r, 50))
  deliverInbound(broker, { chat_id: '-100', message_thread_id: '99', is_general: false }, 'orphan', { thread_id: 99, is_private: false })
  await new Promise(r => setTimeout(r, 30))
  expect(gotHub.length).toBe(1)
  expect(gotHub[0].meta.unrouted).toBe(true)
  await broker.stop()
})
