# Telegram Threads, Multi-Session & Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one Telegram bot serve many concurrent Claude Code sessions — each bound to its own forum topic — coordinated by a General-topic orchestrator, with native Rich Messages (Bot API 10.1).

**Architecture:** A detached **broker** daemon (one per state dir) owns the single `getUpdates` poll, gates messages, and routes each update to the session that registered for its `message_thread_id` over a Unix-domain socket. Sessions become IPC clients that still send outbound directly to the Bot API. Role is chosen at launch by `TELEGRAM_TOPIC` (unset=legacy, `general`=orchestrator, numeric=worker).

**Tech Stack:** Bun, TypeScript, grammy `1.41.1` (raw API for 10.1 methods), `@modelcontextprotocol/sdk`, Node `net` (Unix socket), `bun test`.

**Spec:** `docs/specs/2026-07-16-threads-orchestrator-design.md`

---

## Conventions for this plan

- **Working dir for all paths:** `external_plugins/telegram/` (repo `claude-plugins-official`). Paths below are relative to it.
- **Extraction steps** name exact source line ranges in the *current* `server.ts` (1039 lines) and the exact exported signature to produce. Move the code **verbatim**, add `export`, and swap module-global references for parameters where the signature says so. Do not rewrite logic during a pure extraction.
- **Tests** run with `bun test <file>`. The plugin has no tests today; Task 1 establishes the runner.
- **Commit** after every task's tests pass. Branch first (we are on `main`): `git checkout -b telegram-threads-orchestrator` before Task 1.
- Regressions must stay green: after each phase, `TELEGRAM_TOPIC` unset must behave exactly like today (legacy mode).

---

## File structure (target)

| File | Responsibility |
| --- | --- |
| `config.ts` | Load `.env`; export state-dir path constants, `TOKEN`, `STATIC`, and `parseBinding()` (role from `TELEGRAM_TOPIC`). |
| `access.ts` | `Access` types + file IO (`loadAccess`/`saveAccess`/`pruneExpired`), `gate`/`dmCommandGate`/`isMentioned`, `assertAllowedChat`. |
| `chunk.ts` | The 4096 text splitter. |
| `ipc.ts` | Socket path, frame type unions, `encodeFrame`, `LineDecoder`. |
| `richtext.ts` | Rich send/edit via `bot.api.raw` + capability probe/fallback. |
| `telegram.ts` | `Bot` construction, `assertSendable`, chunked text send, file send. |
| `spawn.ts` | `validateCwd()` + `buildSpawnCommand()` + launch/stop helpers. |
| `broker.ts` | Poller + gate + registry + router + pairing + self-reap (the daemon). |
| `server.ts` | IPC client + MCP server + tools (reply/react/edit/download + orchestrator tools). |
| `routing.ts` | Pure `routeTarget(meta, registry)` decision (imported by broker; unit-tested). |

---

## Phase 0 — Branch & test runner

### Task 1: Establish the test runner and `config.ts` with role parsing

**Files:**
- Create: `config.ts`
- Test: `config.test.ts`

- [ ] **Step 1: Branch**

```bash
cd external_plugins/telegram
git checkout -b telegram-threads-orchestrator
```

- [ ] **Step 2: Write the failing test**

Create `config.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { parseBinding } from './config'

test('unset TELEGRAM_TOPIC → legacy', () => {
  expect(parseBinding(undefined)).toEqual({ role: 'legacy', topicId: null })
  expect(parseBinding('')).toEqual({ role: 'legacy', topicId: null })
})

test('general → orchestrator (case-insensitive)', () => {
  expect(parseBinding('general')).toEqual({ role: 'orchestrator', topicId: null })
  expect(parseBinding('General')).toEqual({ role: 'orchestrator', topicId: null })
})

test('numeric → worker for that topic', () => {
  expect(parseBinding('34')).toEqual({ role: 'worker', topicId: 34 })
})

test('invalid value throws', () => {
  expect(() => parseBinding('not-a-topic')).toThrow()
  expect(() => parseBinding('-5')).toThrow()
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun test config.test.ts`
Expected: FAIL — cannot find module `./config`.

- [ ] **Step 4: Create `config.ts`**

Move the `.env` loader + path constants out of `server.ts` (current lines 26–54) and add role parsing:

```ts
import { readFileSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const STATE_DIR =
  process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const APPROVED_DIR = join(STATE_DIR, 'approved')
export const ENV_FILE = join(STATE_DIR, '.env')
export const INBOX_DIR = join(STATE_DIR, 'inbox')
export const PID_FILE = join(STATE_DIR, 'bot.pid')
export const SOCK_FILE = join(STATE_DIR, 'broker.sock')
export const SESSIONS_FILE = join(STATE_DIR, 'sessions.json')

// Load ~/.claude/channels/telegram/.env into process.env. Real env wins.
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

export const TOKEN = process.env.TELEGRAM_BOT_TOKEN
export const STATIC = process.env.TELEGRAM_ACCESS_MODE === 'static'

export type Role = 'worker' | 'orchestrator' | 'legacy'
export type Binding = { role: Role; topicId: number | null }

/** Decide this process's role purely from TELEGRAM_TOPIC (never from traffic). */
export function parseBinding(topic: string | undefined): Binding {
  const t = (topic ?? '').trim()
  if (t === '') return { role: 'legacy', topicId: null }
  if (t.toLowerCase() === 'general') return { role: 'orchestrator', topicId: null }
  if (/^[0-9]+$/.test(t)) return { role: 'worker', topicId: Number(t) }
  throw new Error(`invalid TELEGRAM_TOPIC "${topic}" — use a numeric topic id, "general", or leave unset`)
}

export const BINDING = parseBinding(process.env.TELEGRAM_TOPIC)
```

- [ ] **Step 5: Run to verify it passes**

Run: `bun test config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add config.ts config.test.ts
git commit -m "feat(telegram): add config module with TELEGRAM_TOPIC role parsing"
```

---

## Phase 1 — Extract shared modules (no behavior change)

### Task 2: Extract `chunk.ts`

**Files:**
- Create: `chunk.ts`, `chunk.test.ts`
- Modify: `server.ts` (remove local `chunk`, import from `./chunk`)

- [ ] **Step 1: Write the failing test**

Create `chunk.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { chunk } from './chunk'

test('short text returns single chunk', () => {
  expect(chunk('hello', 4096, 'length')).toEqual(['hello'])
})

test('length mode hard-cuts at limit', () => {
  const parts = chunk('a'.repeat(10), 4, 'length')
  expect(parts.every(p => p.length <= 4)).toBe(true)
  expect(parts.join('')).toBe('a'.repeat(10))
})

test('newline mode prefers paragraph boundary', () => {
  const text = 'para one here\n\npara two here'
  const parts = chunk(text, 16, 'newline')
  expect(parts[0]).toBe('para one here')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test chunk.test.ts`
Expected: FAIL — cannot find module `./chunk`.

- [ ] **Step 3: Create `chunk.ts`**

Move `chunk` verbatim from current `server.ts` lines 357–376, add `export`:

```ts
export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}
```

- [ ] **Step 4: Update `server.ts`**

Delete the local `chunk` function (lines 357–376) and add near the top imports:

```ts
import { chunk } from './chunk'
```

- [ ] **Step 5: Run to verify tests pass and server still typechecks**

Run: `bun test chunk.test.ts && bun build server.ts --target=bun --outfile=/dev/null`
Expected: tests PASS; build succeeds (no unresolved `chunk`).

- [ ] **Step 6: Commit**

```bash
git add chunk.ts chunk.test.ts server.ts
git commit -m "refactor(telegram): extract chunk() into chunk.ts"
```

---

### Task 3: Extract `access.ts` (types, IO, gating)

**Files:**
- Create: `access.ts`, `access.test.ts`
- Modify: `server.ts`

- [ ] **Step 1: Write the failing test**

Create `access.test.ts`. `gate`/`isMentioned` take a minimal `Context`-shaped object, so we can build fakes:

```ts
import { expect, test } from 'bun:test'
import { defaultAccess, pruneExpired, isMentioned } from './access'

test('defaultAccess is pairing with empty lists', () => {
  const a = defaultAccess()
  expect(a.dmPolicy).toBe('pairing')
  expect(a.allowFrom).toEqual([])
  expect(a.groups).toEqual({})
})

test('pruneExpired removes past-due pending codes', () => {
  const a = defaultAccess()
  a.pending['dead'] = { senderId: '1', chatId: '1', createdAt: 0, expiresAt: 1, replies: 1 }
  a.pending['live'] = { senderId: '2', chatId: '2', createdAt: 0, expiresAt: 2 ** 53, replies: 1 }
  expect(pruneExpired(a)).toBe(true)
  expect(Object.keys(a.pending)).toEqual(['live'])
})

test('isMentioned matches a reply to the bot', () => {
  const ctx: any = { message: { reply_to_message: { from: { username: 'mybot' } }, entities: [], text: 'hi' } }
  expect(isMentioned(ctx, 'mybot')).toBe(true)
  expect(isMentioned(ctx, 'otherbot')).toBe(false)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test access.test.ts`
Expected: FAIL — cannot find module `./access`.

- [ ] **Step 3: Create `access.ts`**

Move these verbatim from current `server.ts` into `access.ts`, adding `export` and the parameter changes noted:

- Types `PendingEntry` (89–95), `GroupPolicy` (97–100), `Access` (102–117). **Extend `Access`** with two optional keys:
  ```ts
  spawnRoots?: string[]
  defaultReplyFormat?: 'text' | 'markdownv2' | 'rich'
  ```
- `defaultAccess` (119–126) — verbatim.
- Constants `MAX_CHUNK_LIMIT` (128), `MAX_ATTACHMENT_BYTES` (129) — verbatim.
- `readAccessFile` (147–170) — verbatim, but read `spawnRoots`/`defaultReplyFormat` too:
  ```ts
  spawnRoots: parsed.spawnRoots,
  defaultReplyFormat: parsed.defaultReplyFormat,
  ```
- `BOOT_ACCESS`/`loadAccess` (172–191) — verbatim.
- `assertAllowedChat` (194–200) — verbatim.
- `saveAccess` (202–208) — verbatim.
- `pruneExpired` (210–220) — verbatim.
- `GateResult` (222–225), `gate` (227–285) — verbatim **except** change the signature to `gate(ctx: Context, botUsername: string): GateResult` and pass `botUsername` into the `isMentioned` call inside it.
- `dmCommandGate` (288–298) — verbatim.
- `isMentioned` (300–324) — verbatim **except** signature becomes `isMentioned(ctx: Context, botUsername: string, extraPatterns?: string[]): boolean` (drop the module-global `botUsername`; use the param).

Add imports at top of `access.ts`:

```ts
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import type { Context } from 'grammy'
import { ACCESS_FILE, STATE_DIR, STATIC } from './config'
```

- [ ] **Step 4: Update `server.ts`**

Remove all the moved declarations. Replace with:

```ts
import {
  type Access, type GateResult,
  defaultAccess, readAccessFile, loadAccess, saveAccess, pruneExpired,
  assertAllowedChat, gate, dmCommandGate, isMentioned,
  MAX_CHUNK_LIMIT, MAX_ATTACHMENT_BYTES,
} from './access'
```

Every call to `gate(ctx)` becomes `gate(ctx, botUsername)`; every `isMentioned(ctx, ...)` becomes `isMentioned(ctx, botUsername, ...)`. (These calls will be removed entirely when polling moves to the broker in Phase 2 — but keep the code compiling now.)

- [ ] **Step 5: Run to verify**

Run: `bun test access.test.ts && bun build server.ts --target=bun --outfile=/dev/null`
Expected: tests PASS; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add access.ts access.test.ts server.ts
git commit -m "refactor(telegram): extract access/gating into access.ts + add spawnRoots/defaultReplyFormat"
```

---

### Task 4: Create `ipc.ts` (frames + line decoder)

**Files:**
- Create: `ipc.ts`, `ipc.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ipc.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test ipc.test.ts`
Expected: FAIL — cannot find module `./ipc`.

- [ ] **Step 3: Create `ipc.ts`**

```ts
export type SessionMeta = {
  chat_id: string
  message_id?: string
  user?: string
  user_id?: string
  ts?: string
  image_path?: string
  message_thread_id?: string
  topic_name?: string
  is_general?: boolean
  unrouted?: boolean
  [k: string]: unknown
}

export type SessionInfo = {
  topic_id: number | null
  role: 'worker' | 'orchestrator' | 'legacy'
  pid: number
  tmux_name?: string
  cwd?: string
  started_at: number
  last_seen: number
  alive: boolean
}

// session → broker
export type SessionFrame =
  | { t: 'register'; role: 'worker' | 'orchestrator' | 'legacy'; topic_id: number | null; pid: number; cwd?: string; tmux_name?: string }
  | { t: 'heartbeat' }
  | { t: 'control'; cmd: 'list_sessions' }

// broker → session
export type BrokerFrame =
  | { t: 'welcome'; bot_username: string; chat_id: string | null }
  | { t: 'inbound'; content: string; meta: SessionMeta }
  | { t: 'sessions'; sessions: SessionInfo[] }
  | { t: 'error'; message: string }

export function encodeFrame(f: SessionFrame | BrokerFrame): string {
  return JSON.stringify(f) + '\n'
}

/** Reassembles newline-delimited JSON frames from arbitrary byte chunks. */
export class LineDecoder<T> {
  private buf = ''
  constructor(private onFrame: (f: T) => void) {}
  push(chunk: Buffer | string): void {
    this.buf += chunk.toString('utf8')
    let nl: number
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (line.trim() === '') continue
      try {
        this.onFrame(JSON.parse(line) as T)
      } catch {
        // Skip malformed line; keep the stream alive.
      }
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test ipc.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add ipc.ts ipc.test.ts
git commit -m "feat(telegram): add ipc frame types and line decoder"
```

---

### Task 5: Create `routing.ts` (pure route decision)

**Files:**
- Create: `routing.ts`, `routing.test.ts`

- [ ] **Step 1: Write the failing test**

Create `routing.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { routeTarget, type Registry } from './routing'

function reg(entries: Array<[string, { role: string }]>): Registry {
  return new Map(entries.map(([id, v]) => [id, { role: v.role as any, topic_id: v.role === 'worker' ? Number(id.split(':')[1]) : null }])) as any
}

test('topic message goes to its worker', () => {
  const r: Registry = new Map([['worker:34', { role: 'worker', topic_id: 34 } as any]])
  expect(routeTarget({ thread_id: 34, is_private: false }, r)).toEqual({ kind: 'deliver', key: 'worker:34' })
})

test('topic with no worker falls back to hub as unrouted', () => {
  const r: Registry = new Map([['hub', { role: 'orchestrator', topic_id: null } as any]])
  expect(routeTarget({ thread_id: 99, is_private: false }, r)).toEqual({ kind: 'deliver', key: 'hub', unrouted: true })
})

test('general (no thread) goes to hub', () => {
  const r: Registry = new Map([['hub', { role: 'legacy', topic_id: null } as any]])
  expect(routeTarget({ thread_id: null, is_private: false }, r)).toEqual({ kind: 'deliver', key: 'hub' })
})

test('DM goes to hub', () => {
  const r: Registry = new Map([['hub', { role: 'orchestrator', topic_id: null } as any]])
  expect(routeTarget({ thread_id: null, is_private: true }, r)).toEqual({ kind: 'deliver', key: 'hub' })
})

test('no hub and no worker → drop', () => {
  expect(routeTarget({ thread_id: 5, is_private: false }, new Map())).toEqual({ kind: 'drop' })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test routing.test.ts`
Expected: FAIL — cannot find module `./routing`.

- [ ] **Step 3: Create `routing.ts`**

```ts
export type RegEntry = { role: 'worker' | 'orchestrator' | 'legacy'; topic_id: number | null }
export type Registry = Map<string, RegEntry>  // key: `worker:<id>` | `hub`

export type RouteInput = { thread_id: number | null; is_private: boolean }
export type RouteResult =
  | { kind: 'deliver'; key: string; unrouted?: boolean }
  | { kind: 'drop' }

/** The single hub is whichever of legacy/orchestrator is registered (at most one). */
function hubKey(reg: Registry): string | null {
  for (const [key, v] of reg) if (v.role === 'orchestrator' || v.role === 'legacy') return key
  return null
}

export function routeTarget(input: RouteInput, reg: Registry): RouteResult {
  const hub = hubKey(reg)
  // Topic message → its worker.
  if (input.thread_id != null && !input.is_private) {
    const key = `worker:${input.thread_id}`
    if (reg.has(key)) return { kind: 'deliver', key }
    if (hub) return { kind: 'deliver', key: hub, unrouted: true }
    return { kind: 'drop' }
  }
  // General topic or DM → hub.
  if (hub) return { kind: 'deliver', key: hub }
  return { kind: 'drop' }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test routing.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add routing.ts routing.test.ts
git commit -m "feat(telegram): add pure routeTarget() decision"
```

---

## Phase 2 — Broker daemon

### Task 6: Broker socket server — singleton bind, registry, register/heartbeat/disconnect

**Files:**
- Create: `broker.ts`, `broker.test.ts`

- [ ] **Step 1: Write the failing test**

Create `broker.test.ts`. It drives the broker's connection handling through a real Unix socket in a temp dir, but with polling disabled (`BROKER_NO_POLL=1`):

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test broker.test.ts`
Expected: FAIL — cannot find module `./broker`.

- [ ] **Step 3: Create `broker.ts` (connection layer only; polling added in Task 7)**

```ts
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
    stop: () => new Promise<void>(res => { server.close(() => { rmSync(opts.sockPath, { force: true }); res() }) }),
  }
  return broker
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test broker.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add broker.ts broker.test.ts
git commit -m "feat(telegram): broker socket server with registry + hub singleton"
```

---

### Task 7: Broker polling + gating + routing to sessions

**Files:**
- Modify: `broker.ts`
- Test: `broker-routing.test.ts`

- [ ] **Step 1: Write the failing test**

Create `broker-routing.test.ts`. We test the internal `deliverInbound(broker, meta, content)` helper (exported for test) so we don't need a live Telegram feed:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test broker-routing.test.ts`
Expected: FAIL — `deliverInbound` is not exported.

- [ ] **Step 3: Add routing + polling to `broker.ts`**

Add these imports and helpers. Keep `conns` addressable by key by storing the socket on the registry side; add a `connByKey` map inside `startBroker` and return it on `broker`:

In `startBroker`, add `const connByKey = new Map<string, BrokerConn>()`, set `connByKey.set(key, conn)` on register, delete it on drop and when refused, and include `connByKey` on the returned `broker` object (extend the `Broker` type with `connByKey: Map<string, BrokerConn>`).

Then add, at module scope:

```ts
import { routeTarget, type RouteInput } from './routing'
import type { SessionMeta } from './ipc'

/** Push a gated message to the correct session. Exported for tests. */
export function deliverInbound(broker: Broker, meta: SessionMeta, content: string, input: RouteInput): void {
  const target = routeTarget(input, broker.registry)
  if (target.kind === 'drop') return
  const conn = broker.connByKey.get(target.key)
  if (!conn) return
  const finalMeta = target.unrouted ? { ...meta, unrouted: true } : meta
  conn.socket.write(encodeFrame({ t: 'inbound', content, meta: finalMeta }))
}
```

Add the poller (runs only when `opts.poll`): move the grammy `Bot` setup + all `bot.on('message:*')` handlers + `bot.command(...)` + `callback_query` + the `bot.start()` retry loop + `checkApprovals` + PID-file/orphan machinery **out of `server.ts`** (current lines 684–1038, plus 55–69 PID logic and 330–352 approvals) into `broker.ts`, wrapped in `if (opts.poll) startPolling(broker)`. Inside each message handler, replace the old `handleInbound` body: after `gate(ctx, botUsername)` approves, compute:

```ts
const chatType = ctx.chat?.type
const threadId = ctx.message?.message_thread_id ?? null
const isGeneral = (chatType === 'supergroup' || chatType === 'group') && threadId == null
const input: RouteInput = { thread_id: threadId, is_private: chatType === 'private' }
const meta: SessionMeta = {
  chat_id: String(ctx.chat!.id),
  message_id: ctx.message ? String(ctx.message.message_id) : undefined,
  user: ctx.from?.username ?? String(ctx.from?.id),
  user_id: String(ctx.from?.id),
  ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
  message_thread_id: threadId != null ? String(threadId) : undefined,
  is_general: isGeneral || undefined,
  ...(imagePath ? { image_path: imagePath } : {}),
  ...(attachment ? { /* same attachment_* fields as today, lines 974–980 */ } : {}),
}
deliverInbound(broker, meta, text, input)
```

The permission-relay intercept (current 927–943), pairing replies (910–916), typing indicator (946) and ack reaction (951–957) stay in the broker's handler unchanged.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test broker-routing.test.ts && bun test`
Expected: routing tests PASS; all prior tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add broker.ts broker-routing.test.ts
git commit -m "feat(telegram): broker polls, gates, and routes inbound by topic"
```

---

### Task 8: Broker entrypoint + self-reap + permission notifications

**Files:**
- Modify: `broker.ts`

- [ ] **Step 1: Add the standalone entrypoint**

At the bottom of `broker.ts`, guard a run block so `bun broker.ts` launches the daemon:

```ts
if (import.meta.main) {
  const { SOCK_FILE, TOKEN } = await import('./config')
  if (!TOKEN) { process.stderr.write('broker: TELEGRAM_BOT_TOKEN required\n'); process.exit(1) }
  const broker = await startBroker({ sockPath: SOCK_FILE, poll: true })
  // Self-reap 30s after the last client disconnects.
  setInterval(() => {
    if (broker.conns.size === 0) {
      if (broker.idleSince == null) broker.idleSince = Date.now()
      else if (Date.now() - broker.idleSince > 30_000) { void broker.stop().then(() => process.exit(0)) }
    } else broker.idleSince = null
  }, 5000).unref()
  process.on('SIGTERM', () => void broker.stop().then(() => process.exit(0)))
  process.on('SIGINT', () => void broker.stop().then(() => process.exit(0)))
}
```

Add `idleSince: number | null` to the `Broker` type (init `null`).

- [ ] **Step 2: Move permission-request notification bridge**

The broker (not the session) holds the Telegram send path for permission prompts. But `permission_request` notifications arrive on the **MCP** connection, which lives in `server.ts`. Decision: keep the permission MCP handler in `server.ts` (it has the MCP server), and have the session **send the prompt itself** to its own topic via the Bot API (thread-aware). So this step only removes the permission-send code from the broker path; the send lands in Task 11. No broker code needed beyond confirming `handleInbound`'s permission-reply intercept (text "yes xxxxx") still emits `notifications/claude/channel/permission` — but that notification must reach the MCP server. Since the broker has no MCP connection, route permission replies to the hub/worker as a normal inbound frame with a reserved marker:

Add to `deliverInbound` callers in the permission-reply branch: instead of `mcp.notification`, send an inbound frame with `meta.permission = { request_id, behavior }`. The session translates it (Task 11).

Update `SessionMeta` in `ipc.ts`:

```ts
permission?: { request_id: string; behavior: 'allow' | 'deny' }
```

- [ ] **Step 3: Run to verify**

Run: `bun test && bun build broker.ts --target=bun --outfile=/dev/null`
Expected: tests PASS; broker builds.

- [ ] **Step 4: Commit**

```bash
git add broker.ts ipc.ts
git commit -m "feat(telegram): broker entrypoint, self-reap, permission-reply relay frame"
```

---

## Phase 3 — Session as IPC client + rich outbound

### Task 9: Create `richtext.ts` (rich send/edit + fallback)

**Files:**
- Create: `richtext.ts`, `richtext.test.ts`

- [ ] **Step 1: Write the failing test**

Create `richtext.test.ts` with a mock `api.raw`:

```ts
import { expect, test } from 'bun:test'
import { sendRich, resetRichCapability, isRichSupported } from './richtext'

function mockApi(behavior: 'ok' | 'unsupported') {
  return {
    raw: {
      sendRichMessage: async (_p: any) => {
        if (behavior === 'unsupported') { const e: any = new Error('Method not found'); e.error_code = 404; throw e }
        return { message_id: 7 }
      },
    },
  } as any
}

test('sendRich returns message id when supported', async () => {
  resetRichCapability()
  const id = await sendRich(mockApi('ok'), { chat_id: '1', text: '# hi', message_thread_id: 34 })
  expect(id).toBe(7)
  expect(isRichSupported()).toBe(true)
})

test('sendRich throws RichUnsupported and flips capability off', async () => {
  resetRichCapability()
  await expect(sendRich(mockApi('unsupported'), { chat_id: '1', text: 'x' })).rejects.toThrow('RichUnsupported')
  expect(isRichSupported()).toBe(false)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test richtext.test.ts`
Expected: FAIL — cannot find module `./richtext`.

- [ ] **Step 3: Create `richtext.ts`**

```ts
import type { Api } from 'grammy'

export class RichUnsupported extends Error {
  constructor(cause: string) { super(`RichUnsupported: ${cause}`) }
}

let richSupported = true
export function isRichSupported(): boolean { return richSupported }
export function resetRichCapability(): void { richSupported = true }

type RawRich = { sendRichMessage: (p: unknown) => Promise<{ message_id: number }> }

function looksUnsupported(err: any): boolean {
  const code = err?.error_code
  const desc = String(err?.description ?? err?.message ?? '')
  return code === 404 || /not found|unsupported|unknown method|BOT_METHOD_INVALID/i.test(desc)
}

export type SendRichParams = {
  chat_id: string
  text: string
  message_thread_id?: number
  reply_to?: number
}

/** Send a Rich Message (Markdown-native). Throws RichUnsupported to trigger fallback. */
export async function sendRich(api: Api, p: SendRichParams): Promise<number> {
  const raw = (api as any).raw as RawRich
  try {
    const res = await raw.sendRichMessage({
      chat_id: p.chat_id,
      ...(p.message_thread_id != null ? { message_thread_id: p.message_thread_id } : {}),
      rich_message: { markdown: p.text },
      ...(p.reply_to != null ? { reply_parameters: { message_id: p.reply_to } } : {}),
    })
    richSupported = true
    return res.message_id
  } catch (err) {
    if (looksUnsupported(err)) { richSupported = false; throw new RichUnsupported(String((err as any)?.description ?? err)) }
    throw err
  }
}

export async function editRich(api: Api, chat_id: string, message_id: number, text: string): Promise<number> {
  const raw = (api as any).raw as { editMessageText: (p: unknown) => Promise<any> }
  try {
    const res = await raw.editMessageText({ chat_id, message_id, rich_message: { markdown: text } })
    richSupported = true
    return typeof res === 'object' ? res.message_id : message_id
  } catch (err) {
    if (looksUnsupported(err)) { richSupported = false; throw new RichUnsupported(String((err as any)?.description ?? err)) }
    throw err
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test richtext.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add richtext.ts richtext.test.ts
git commit -m "feat(telegram): rich message send/edit with capability fallback"
```

---

### Task 10: Rewrite `server.ts` as the IPC client (inbound path)

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: Add a broker-connect helper**

At the top of `server.ts` after imports, add a function that ensures the broker is up and connects:

```ts
import net from 'net'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { encodeFrame, LineDecoder, type BrokerFrame } from './ipc'
import { SOCK_FILE, BINDING } from './config'

function connectBroker(onFrame: (f: BrokerFrame) => void): Promise<net.Socket> {
  return new Promise((resolve) => {
    const attempt = (triesLeft: number) => {
      const s = net.createConnection(SOCK_FILE)
      s.on('connect', () => {
        const dec = new LineDecoder<BrokerFrame>(onFrame)
        s.on('data', d => dec.push(d))
        s.write(encodeFrame({ t: 'register', role: BINDING.role, topic_id: BINDING.topicId, pid: process.pid }))
        setInterval(() => s.write(encodeFrame({ t: 'heartbeat' })), 10_000).unref()
        resolve(s)
      })
      s.on('error', () => {
        if (triesLeft <= 0) { spawnBroker() }
        setTimeout(() => attempt(triesLeft - 1), 300)
      })
    }
    attempt(10)
  })
}

function spawnBroker(): void {
  const brokerPath = fileURLToPath(new URL('./broker.ts', import.meta.url))
  const child = spawn('bun', [brokerPath], { detached: true, stdio: 'ignore', env: process.env })
  child.unref()
}
```

- [ ] **Step 2: Convert inbound frames to MCP notifications**

Replace the old polling/`handleInbound` inbound emission (removed in Task 7) with a frame handler. Keep the exact `notifications/claude/channel` shape:

Keep the existing `const bot = new Bot(TOKEN)` for **outbound only** (it never calls `bot.start()` now). Import `TOKEN` from `./config` and keep the existing "exit if no token" guard (current lines 45–52) so `new Bot(TOKEN)` gets a defined token.

```ts
let brokerSocket: net.Socket | null = null
let botChatIdHint = ''
// list_sessions round-trip state (the tool itself is added in Task 12).
let sessionsWaiters: Array<(s: any[]) => void> = []
function resolvePendingSessions(s: any[]): void { for (const w of sessionsWaiters) w(s); sessionsWaiters = [] }

async function startInbound(): Promise<void> {
  brokerSocket = await connectBroker(frame => {
    if (frame.t === 'welcome') { botChatIdHint = frame.chat_id ?? ''; return }
    if (frame.t === 'inbound') {
      if (frame.meta.permission) {
        void mcp.notification({
          method: 'notifications/claude/channel/permission',
          params: { request_id: frame.meta.permission.request_id, behavior: frame.meta.permission.behavior },
        })
        return
      }
      void mcp.notification({ method: 'notifications/claude/channel', params: { content: frame.content, meta: frame.meta } })
      return
    }
    if (frame.t === 'sessions') { resolvePendingSessions(frame.sessions); return }
    if (frame.t === 'error') { process.stderr.write(`telegram session: broker error: ${frame.message}\n`) }
  })
}
```

Delete from `server.ts`: the entire `bot.start()` retry loop, all `bot.on('message:*')`/`bot.command`/`callback_query` handlers, `handleInbound`, `checkApprovals`, PID-file logic, and the orphan watchdog (they now live in `broker.ts`). Keep the `Bot` instance **only** for outbound (`bot.api`). Call `await startInbound()` before `await mcp.connect(...)`.

- [ ] **Step 3: Run to verify**

Run: `bun build server.ts --target=bun --outfile=/dev/null && bun test`
Expected: build succeeds; all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add server.ts
git commit -m "refactor(telegram): server.ts is now an IPC client, not a poller"
```

---

### Task 11: Thread-aware + rich `reply` / `edit_message`; permission prompt to topic

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: Add `message_thread_id` + `format:'rich'` to the `reply` tool schema**

In the `reply` tool `inputSchema.properties`, add:

```ts
message_thread_id: { type: 'string', description: 'Forum topic id to send into. Defaults to this session\'s bound topic.' },
```

and extend `format.enum` to `['text', 'markdownv2', 'rich']`.

- [ ] **Step 2: Implement rich + thread in the `reply` handler**

In the `reply` case, resolve the thread and format, then try rich first when selected:

```ts
const access = loadAccess()
const threadId =
  args.message_thread_id != null ? Number(args.message_thread_id)
  : BINDING.topicId ?? undefined
const chosen = (args.format as string | undefined) ?? access.defaultReplyFormat ?? 'text'

if (chosen === 'rich') {
  try {
    const id = await sendRich(bot.api, { chat_id, text, message_thread_id: threadId, reply_to })
    return { content: [{ type: 'text', text: `sent (id: ${id})` }] }
  } catch (err) {
    if (!(err instanceof RichUnsupported)) throw err
    process.stderr.write('telegram session: rich unsupported, falling back to text\n')
    // fall through to the existing chunked path below
  }
}
```

In the existing chunked-send path, thread every eligible chunk/file with `message_thread_id` alongside the existing `reply_parameters`:

```ts
const sent = await bot.api.sendMessage(chat_id, chunks[i], {
  ...(shouldReplyTo ? { reply_parameters: { message_id: reply_to } } : {}),
  ...(threadId != null ? { message_thread_id: threadId } : {}),
  ...(parseMode ? { parse_mode: parseMode } : {}),
})
```

Apply the same `message_thread_id` addition to `sendPhoto`/`sendDocument` opts.

- [ ] **Step 3: `edit_message` rich support**

In `edit_message`, when `format==='rich'` try `editRich(bot.api, chat_id, message_id, text)`, catching `RichUnsupported` to fall back to the existing `editMessageText` path.

- [ ] **Step 4: Permission prompt to the session's topic**

The permission `notifications/.../permission_request` handler currently broadcasts to all DMs (lines 418–443). Change it: when this session is a worker (`BINDING.role==='worker'`), send the prompt into `chat_id = <group>` with `message_thread_id = BINDING.topicId`. The group chat id comes from the `welcome` frame (`botChatIdHint`) or the last inbound meta's `chat_id`. For legacy/orchestrator keep the DM-broadcast behavior.

- [ ] **Step 5: Manual verification (documented, not a unit test)**

Run: with a real bot + supergroup, send a message in a worker's topic and confirm the reply lands **in that topic** and renders Markdown. Confirm legacy DM still works with `format` omitted.

- [ ] **Step 6: Commit**

```bash
git add server.ts
git commit -m "feat(telegram): thread-aware + rich reply/edit; permission prompt to topic"
```

---

## Phase 4 — Orchestrator tools

### Task 12: `list_sessions` tool

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: Register the tool only for the orchestrator**

In `ListToolsRequestSchema`, append these tools **only when** `BINDING.role === 'orchestrator'`:

```ts
{ name: 'list_sessions', description: 'List all sessions the broker is routing: topic id, role, pid, cwd, liveness.', inputSchema: { type: 'object', properties: {} } },
```

- [ ] **Step 2: Implement via a broker control round-trip**

Add a request helper over the existing socket. (`sessionsWaiters`/`resolvePendingSessions` were already declared in Task 10; do **not** redeclare them — only add `requestSessions`.)

```ts
function requestSessions(): Promise<any[]> {
  return new Promise(res => { sessionsWaiters.push(res); brokerSocket?.write(encodeFrame({ t: 'control', cmd: 'list_sessions' })); setTimeout(() => res([]), 2000) })
}
```

Handle the tool:

```ts
case 'list_sessions': {
  const sessions = await requestSessions()
  return { content: [{ type: 'text', text: JSON.stringify(sessions, null, 2) }] }
}
```

- [ ] **Step 3: Run to verify**

Run: `bun build server.ts --target=bun --outfile=/dev/null`
Expected: builds.

- [ ] **Step 4: Commit**

```bash
git add server.ts
git commit -m "feat(telegram): orchestrator list_sessions tool"
```

---

### Task 13: Forum-topic management tools (`create_topic`/`edit_topic`/`close_topic`/`reopen_topic`)

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: Register the tools (orchestrator only)**

```ts
{ name: 'create_topic', description: 'Create a forum topic in the supergroup. Returns its message_thread_id.', inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, name: { type: 'string' }, icon_color: { type: 'number' } }, required: ['chat_id', 'name'] } },
{ name: 'edit_topic', description: 'Rename a forum topic.', inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, message_thread_id: { type: 'string' }, name: { type: 'string' } }, required: ['chat_id', 'message_thread_id', 'name'] } },
{ name: 'close_topic', description: 'Close a forum topic.', inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, message_thread_id: { type: 'string' } }, required: ['chat_id', 'message_thread_id'] } },
{ name: 'reopen_topic', description: 'Reopen a forum topic.', inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, message_thread_id: { type: 'string' } }, required: ['chat_id', 'message_thread_id'] } },
```

- [ ] **Step 2: Implement handlers (grammy has typed methods for these)**

```ts
case 'create_topic': {
  assertAllowedChat(args.chat_id as string)
  const t = await bot.api.createForumTopic(args.chat_id as string, args.name as string,
    args.icon_color != null ? { icon_color: Number(args.icon_color) } : undefined)
  return { content: [{ type: 'text', text: `topic "${t.name}" id ${t.message_thread_id}` }] }
}
case 'edit_topic': {
  assertAllowedChat(args.chat_id as string)
  await bot.api.editForumTopic(args.chat_id as string, Number(args.message_thread_id), { name: args.name as string })
  return { content: [{ type: 'text', text: 'renamed' }] }
}
case 'close_topic': {
  assertAllowedChat(args.chat_id as string)
  await bot.api.closeForumTopic(args.chat_id as string, Number(args.message_thread_id))
  return { content: [{ type: 'text', text: 'closed' }] }
}
case 'reopen_topic': {
  assertAllowedChat(args.chat_id as string)
  await bot.api.reopenForumTopic(args.chat_id as string, Number(args.message_thread_id))
  return { content: [{ type: 'text', text: 'reopened' }] }
}
```

- [ ] **Step 3: Run to verify**

Run: `bun build server.ts --target=bun --outfile=/dev/null`
Expected: builds (grammy 1.41.1 has these forum methods typed).

- [ ] **Step 4: Commit**

```bash
git add server.ts
git commit -m "feat(telegram): orchestrator forum-topic management tools"
```

---

### Task 14: `spawn.ts` — required `spawnRoots` validation + command builder

**Files:**
- Create: `spawn.ts`, `spawn.test.ts`

- [ ] **Step 1: Write the failing test**

Create `spawn.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { validateCwd, buildSpawnCommand } from './spawn'

test('validateCwd refuses when spawnRoots is unset/empty', () => {
  const dir = mkdtempSync(join_tmp())
  expect(() => validateCwd(dir, undefined)).toThrow(/spawnRoots/)
  expect(() => validateCwd(dir, [])).toThrow(/spawnRoots/)
})

test('validateCwd refuses a cwd outside every root', () => {
  const root = mkdtempSync(join_tmp())
  const other = mkdtempSync(join_tmp())
  expect(() => validateCwd(other, [root])).toThrow(/not under/)
})

test('validateCwd accepts a cwd under a root', () => {
  const root = mkdtempSync(join_tmp())
  expect(validateCwd(root, [root])).toBe(true)
})

test('buildSpawnCommand uses tmux with env and cwd', () => {
  const cmd = buildSpawnCommand({ topicId: 34, cwd: '/x', useTmux: true })
  expect(cmd.file).toBe('tmux')
  expect(cmd.args.join(' ')).toContain('tg-34')
  expect(cmd.args.join(' ')).toContain('TELEGRAM_TOPIC=34')
})

function join_tmp() { return require('path').join(tmpdir(), 'tg-spawn-') }
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test spawn.test.ts`
Expected: FAIL — cannot find module `./spawn`.

- [ ] **Step 3: Create `spawn.ts`**

```ts
import { realpathSync, statSync } from 'fs'
import { sep } from 'path'

/** Required-spawnRoots gate: throws unless cwd resolves under a configured root. */
export function validateCwd(cwd: string, spawnRoots: string[] | undefined): true {
  if (!spawnRoots || spawnRoots.length === 0) {
    throw new Error('spawn refused: configure "spawnRoots" in access.json to enable spawning worker sessions')
  }
  let real: string
  try { real = realpathSync(cwd) } catch { throw new Error(`spawn refused: cwd does not exist: ${cwd}`) }
  if (!statSync(real).isDirectory()) throw new Error(`spawn refused: cwd is not a directory: ${cwd}`)
  const ok = spawnRoots.some(root => {
    let r: string
    try { r = realpathSync(root) } catch { return false }
    return real === r || real.startsWith(r + sep)
  })
  if (!ok) throw new Error(`spawn refused: cwd not under any spawnRoots entry: ${cwd}`)
  return true
}

export type SpawnCmd = { file: string; args: string[] }

export function buildSpawnCommand(p: { topicId: number; cwd: string; useTmux: boolean }): SpawnCmd {
  const inner = `TELEGRAM_TOPIC=${p.topicId} claude --channels plugin:telegram@claude-plugins-official`
  if (p.useTmux) {
    return { file: 'tmux', args: ['new-session', '-d', '-s', `tg-${p.topicId}`, '-c', p.cwd, inner] }
  }
  return { file: 'sh', args: ['-c', `cd ${JSON.stringify(p.cwd)} && nohup ${inner} > ${JSON.stringify(`worker-${p.topicId}.log`)} 2>&1 &`] }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test spawn.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add spawn.ts spawn.test.ts
git commit -m "feat(telegram): spawn cwd validation (required spawnRoots) + command builder"
```

---

### Task 15: `spawn_session` / `stop_session` orchestrator tools

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: Register the tools (orchestrator only)**

```ts
{ name: 'spawn_session', description: 'Launch a detached Claude Code worker bound to a topic. Requires spawnRoots configured; cwd must be under a root.', inputSchema: { type: 'object', properties: { topic_id: { type: 'string' }, cwd: { type: 'string' } }, required: ['topic_id', 'cwd'] } },
{ name: 'stop_session', description: 'Stop the worker bound to a topic (kills its tmux session or process).', inputSchema: { type: 'object', properties: { topic_id: { type: 'string' } }, required: ['topic_id'] } },
```

- [ ] **Step 2: Implement `spawn_session`**

```ts
case 'spawn_session': {
  const access = loadAccess()
  const cwd = args.cwd as string
  validateCwd(cwd, access.spawnRoots)           // throws → returned as isError below
  const topicId = Number(args.topic_id)
  const useTmux = await hasTmux()
  const cmd = buildSpawnCommand({ topicId, cwd, useTmux })
  const child = spawn(cmd.file, cmd.args, { detached: true, stdio: 'ignore', cwd, env: process.env })
  child.unref()
  return { content: [{ type: 'text', text: `spawned worker for topic ${topicId} in ${cwd} (${useTmux ? 'tmux tg-' + topicId : 'nohup'})` }] }
}
```

Add helper:

```ts
function hasTmux(): Promise<boolean> {
  return new Promise(res => { const p = spawn('tmux', ['-V'], { stdio: 'ignore' }); p.on('error', () => res(false)); p.on('exit', c => res(c === 0)) })
}
```

- [ ] **Step 3: Implement `stop_session`**

Prefer killing the tmux session; fall back to the recorded pid from `list_sessions`:

```ts
case 'stop_session': {
  const topicId = Number(args.topic_id)
  const sessions = await requestSessions()
  const info = sessions.find((s: any) => s.topic_id === topicId)
  if (await hasTmux()) { spawn('tmux', ['kill-session', '-t', `tg-${topicId}`], { stdio: 'ignore' }).unref() }
  if (info?.pid) { try { process.kill(info.pid, 'SIGTERM') } catch {} }
  return { content: [{ type: 'text', text: `stop signal sent for topic ${topicId}` }] }
}
```

- [ ] **Step 4: Run to verify**

Run: `bun build server.ts --target=bun --outfile=/dev/null && bun test`
Expected: builds; all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server.ts
git commit -m "feat(telegram): spawn_session/stop_session orchestrator tools"
```

---

## Phase 5 — Docs, skills, packaging

### Task 16: Update server `instructions` for threads + rich + orchestrator

**Files:**
- Modify: `server.ts` (the `instructions` array, current lines 397–407)

- [ ] **Step 1: Add three lines to the instructions string**

Append:

```
'Forum topics: inbound meta may include message_thread_id and topic_name. reply threads back automatically to this session\'s bound topic; pass message_thread_id to target another topic. Prefer format:"rich" so Markdown (headings, code, lists, tables) renders natively; it falls back to plain text if unsupported.',
'',
'If you are the General-topic orchestrator, you have list_sessions, create_topic/edit_topic/close_topic/reopen_topic, and spawn_session/stop_session. Route work into a topic by calling reply with its message_thread_id. Never spawn outside configured spawnRoots.',
```

- [ ] **Step 2: Commit**

```bash
git add server.ts
git commit -m "docs(telegram): server instructions for topics, rich, orchestrator"
```

---

### Task 17: README + ACCESS docs

**Files:**
- Modify: `README.md`, `ACCESS.md`

- [ ] **Step 1: README — add a "Multiple sessions & topics" section**

After the Quick Setup, document: enable Topics on a supergroup; add the group via `/telegram:access group add <id> --no-mention`; launch the orchestrator with `TELEGRAM_TOPIC=general claude --channels …` in General; launch workers with `TELEGRAM_TOPIC=<id> claude --channels …`; note single-host and the broker daemon (`broker.sock`). Add Rich Messages note (Bot API 10.1; `format:'rich'`; automatic fallback).

- [ ] **Step 2: ACCESS — document new keys**

Add to the config schema block and skill reference:

```jsonc
// Required to allow spawn_session. Absolute path prefixes; cwd must resolve under one.
"spawnRoots": ["/Users/me/projects"],
// Default reply rendering when the caller omits `format`.
"defaultReplyFormat": "text"
```

Add a "Topics & orchestrator" subsection describing roles (`TELEGRAM_TOPIC` unset/general/numeric), routing, and the orchestrator tools.

- [ ] **Step 3: Commit**

```bash
git add README.md ACCESS.md
git commit -m "docs(telegram): document topics, orchestrator, rich, spawnRoots"
```

---

### Task 18: `configure` skill — accept `spawnRoots` and role guidance

**Files:**
- Modify: `skills/configure/SKILL.md`

- [ ] **Step 1: Add a "Multi-session" note + `set spawnRoots` guidance**

Document that `spawnRoots` is required before `spawn_session` works, and how to launch orchestrator/worker sessions with `TELEGRAM_TOPIC`. Reference `/telegram:access set spawnRoots '["/abs/path"]'`.

- [ ] **Step 2: Commit**

```bash
git add skills/configure/SKILL.md
git commit -m "docs(telegram): configure skill covers spawnRoots + roles"
```

---

### Task 19: Version bump + full regression

**Files:**
- Modify: `.claude-plugin/plugin.json`, `package.json`

- [ ] **Step 1: Bump versions**

`.claude-plugin/plugin.json` `version` `0.0.6` → `0.1.0`. `package.json` `version` `0.0.1` → `0.1.0`.

- [ ] **Step 2: Full test + build sweep**

Run: `bun test && bun build server.ts --target=bun --outfile=/dev/null && bun build broker.ts --target=bun --outfile=/dev/null`
Expected: all tests PASS; both builds succeed.

- [ ] **Step 3: Legacy smoke (documented manual)**

With no `TELEGRAM_TOPIC` and a plain DM bot, confirm pairing → allowlist → reply/react/edit/photo all behave exactly as before (broker spawns transparently, one hub receives everything).

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/plugin.json package.json
git commit -m "chore(telegram): bump to 0.1.0 for multi-session topics + rich messages"
```

---

## Self-review notes (spec coverage)

- Spec §4.1 broker → Tasks 6–8. §4.2 session client → Tasks 10–11. §4.3 IPC → Task 4. §4.4 module split → Tasks 1–5, 9, 14.
- §5 binding → Task 1 (`parseBinding`). §6 routing → Task 5 (`routeTarget`) + Task 7 (`deliverInbound`). §7 meta → Task 7.
- §8 rich → Tasks 9, 11. §9 orchestrator tools → Tasks 12, 13, 15. §9.1/§9.2 spawn lifecycle + required spawnRoots → Tasks 14, 15.
- §10 config keys → Task 3 (types) + Task 17/18 (docs). §11 back-compat → Tasks 10, 11, 19 (legacy smoke). §12 error handling → Tasks 6 (stale socket), 8 (self-reap), 9 (rich fallback), 14 (spawn refusal). §13 testing → tests throughout. §14 file summary → matches file table.
- §15 future work (streaming, cross-machine) intentionally not implemented.
