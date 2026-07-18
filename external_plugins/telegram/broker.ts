import net from 'net'
import { existsSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { encodeFrame, LineDecoder, type SessionFrame, type SessionInfo } from './ipc'
import { type Registry, type RegEntry } from './routing'

export type BrokerConn = {
  socket: net.Socket
  key: string | null
  info: SessionInfo | null
}

export type Broker = {
  registry: Registry
  conns: Set<BrokerConn>
  stop: () => Promise<void>
}

export type BrokerOpts = { sockPath: string; poll: boolean }

// exported for Task 7 to attach the poller/router
export const HUB_ROLES = new Set(['orchestrator', 'legacy'])

export async function startBroker(opts: BrokerOpts): Promise<Broker> {
  const registry: Registry = new Map()
  const conns = new Set<BrokerConn>()
  const infoByKey = new Map<string, SessionInfo>()

  // Stale socket file from a crashed broker blocks bind; clear it if dead.
  if (existsSync(opts.sockPath)) {
    try {
      await new Promise<void>((res, rej) => {
        const probe = net.createConnection(opts.sockPath)
        probe.on('connect', () => { probe.destroy(); rej(new Error('EADDRINUSE')) })
        probe.on('error', () => { probe.destroy(); res() })
      })
      rmSync(opts.sockPath, { force: true })
    } catch (e) {
      throw e // a live broker already owns the socket
    }
  }

  const server = net.createServer(socket => {
    const conn: BrokerConn = { socket, key: null, info: null }
    conns.add(conn)
    const decoder = new LineDecoder<SessionFrame>(frame => handleFrame(conn, frame))
    socket.on('data', d => decoder.push(d))
    const drop = () => {
      if (conn.key) { registry.delete(conn.key); infoByKey.delete(conn.key) }
      conns.delete(conn)
    }
    socket.on('close', drop)
    socket.on('error', drop)
  })

  function hubPresent(): boolean {
    for (const v of registry.values()) if (HUB_ROLES.has(v.role)) return true
    return false
  }

  function handleFrame(conn: BrokerConn, frame: SessionFrame): void {
    if (frame.t === 'register') {
      if (HUB_ROLES.has(frame.role) && hubPresent()) {
        conn.socket.write(encodeFrame({ t: 'error', message: 'a hub session (orchestrator/legacy) is already registered' }))
        return
      }
      const key = frame.role === 'worker' ? `worker:${frame.topic_id}` : 'hub'
      const entry: RegEntry = { role: frame.role, topic_id: frame.topic_id }
      const info: SessionInfo = {
        topic_id: frame.topic_id, role: frame.role, pid: frame.pid,
        tmux_name: frame.tmux_name, cwd: frame.cwd,
        started_at: Date.now(), last_seen: Date.now(), alive: true,
      }
      conn.key = key
      conn.info = info
      registry.set(key, entry)
      infoByKey.set(key, info)
      persistSessions()
      return
    }
    if (frame.t === 'heartbeat') {
      if (conn.info) conn.info.last_seen = Date.now()
      return
    }
    if (frame.t === 'control' && frame.cmd === 'list_sessions') {
      conn.socket.write(encodeFrame({ t: 'sessions', sessions: [...infoByKey.values()] }))
      return
    }
  }

  function persistSessions(): void {
    try { writeFileSync(opts.sockPath.replace(/broker\.sock$/, 'sessions.json'), JSON.stringify([...infoByKey.values()], null, 2)) } catch {}
  }

  await new Promise<void>((res, rej) => {
    server.once('error', rej)
    server.listen(opts.sockPath, res)
  })

  const broker: Broker = {
    registry, conns,
    stop: () => new Promise<void>(res => {
      // server.close() only fires once every connection has ended, so tear the
      // live sockets down first — otherwise stop() hangs while workers stay open.
      for (const conn of conns) conn.socket.destroy()
      server.close(() => { rmSync(opts.sockPath, { force: true }); res() })
    }),
  }
  return broker
}
