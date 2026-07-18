import { expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import net from 'net'
import { startBroker, type Broker } from './broker'
import { encodeFrame } from './ipc'

function connect(sock: string): Promise<net.Socket> {
  return new Promise((res, rej) => {
    const s = net.createConnection(sock, () => res(s))
    s.on('error', rej)
  })
}

test('register adds a worker to the registry; disconnect prunes it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-broker-'))
  const sock = join(dir, 'broker.sock')
  const broker: Broker = await startBroker({ sockPath: sock, poll: false })

  const c = await connect(sock)
  c.write(encodeFrame({ t: 'register', role: 'worker', topic_id: 34, pid: 111 }))
  await new Promise(r => setTimeout(r, 50))
  expect(broker.registry.has('worker:34')).toBe(true)

  c.destroy()
  await new Promise(r => setTimeout(r, 50))
  expect(broker.registry.has('worker:34')).toBe(false)

  await broker.stop()
})

test('second hub registration is refused (error frame), first survives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-broker-'))
  const sock = join(dir, 'broker.sock')
  const broker: Broker = await startBroker({ sockPath: sock, poll: false })

  const a = await connect(sock)
  a.write(encodeFrame({ t: 'register', role: 'orchestrator', topic_id: null, pid: 1 }))
  await new Promise(r => setTimeout(r, 50))

  const b = await connect(sock)
  const errs: string[] = []
  b.on('data', d => { for (const l of d.toString().split('\n')) if (l) { const f = JSON.parse(l); if (f.t === 'error') errs.push(f.message) } })
  b.write(encodeFrame({ t: 'register', role: 'legacy', topic_id: null, pid: 2 }))
  await new Promise(r => setTimeout(r, 50))

  expect(errs.length).toBe(1)
  expect([...broker.registry.values()].filter(v => v.role !== 'worker').length).toBe(1)

  await broker.stop()
})
