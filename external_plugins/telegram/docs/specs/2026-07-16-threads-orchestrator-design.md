# Telegram plugin: threads, multi-session, orchestrator, and rich messages

**Date:** 2026-07-16
**Status:** Design — pending approval
**Scope:** `external_plugins/telegram`

## 1. Problem

Today the plugin binds **one bot token to one Claude Code session**. `server.ts`
polls Telegram's `getUpdates`, and Telegram permits **exactly one `getUpdates`
consumer per token** — so the server actively kills any competing poller (PID
file, stale-poller SIGTERM, 409-Conflict backoff, orphan watchdog). Two sessions
on one bot fight over the token. There is no notion of a Telegram **thread**
(forum topic / `message_thread_id`) anywhere: inbound meta omits it and all
outbound tools key off `chat_id` alone.

The user wants, on a **single bot**:

1. **Multiple concurrent Claude Code sessions**, each bound to its own Telegram
   forum **topic** (thread) inside one supergroup — no second bot per session.
2. A **General-topic "orchestrator"** session that manages the worker sessions
   from one place: see what's running, create/close topics, route
   messages/tasks into any topic, and **spawn/stop** worker sessions.
3. Support for Telegram's newest **Rich Messages** (Bot API 10.1, released
   2026-06-11) so Claude's Markdown renders natively instead of being flattened
   to plain text and hard-split at 4096 chars.

## 2. Goals / Non-goals

**Goals**

- One bot serves N concurrent sessions, routed by forum topic.
- Deterministic, restart-safe topic binding via a launch env var.
- Orchestrator (General topic) can monitor, route, manage topics, and
  spawn/stop workers.
- `reply` / `edit_message` can emit Rich Messages (Markdown-native) with
  automatic fallback when unsupported.
- **Zero behavior change** for existing single-bot DM users.

**Non-goals (v1)**

- Cross-machine operation. Broker IPC is a local Unix socket and spawning is
  local; the whole system is single-host.
- True token-level streaming of rich replies (the MCP `reply` tool is one-shot;
  Claude calls it once with the full text). Progressive `edit_message` covers
  "working… → result." A dedicated streaming tool is future work (§12).
- Windows multi-session (no Unix-domain-socket path). Legacy single-session DM
  mode still works on Windows; multi-session is POSIX-only, matching the
  plugin's existing POSIX lean.
- Webhooks. Long-poll only.

## 3. Topology

```
                    one bot token
                         │
                  ┌──────┴───────┐
                  │    broker    │  owns getUpdates · gates · routes by message_thread_id
                  └──────┬───────┘
        ┌────────────────┼───────────────────┐
   General topic     topic 34            topic 56
        │                │                   │
  orchestrator        worker              worker
    session          session A           session B
 (control plane)   TELEGRAM_TOPIC=34   TELEGRAM_TOPIC=56
```

In a forum supergroup, **General-topic** messages arrive **without**
`message_thread_id`; regular topic messages carry it (`is_topic_message: true`).
The broker uses that to route.

## 4. Components

### 4.1 Broker daemon (`broker.ts`)

A **detached singleton per `TELEGRAM_STATE_DIR`**. Responsibilities:

- Owns the single `getUpdates` long-poll (all the token-ownership machinery
  currently in `server.ts` — PID file, stale-poller kill, 409 backoff, orphan
  watchdog, `checkApprovals` — **moves here**; it is precisely the "be the one
  poller" code).
- Owns **gating** (`access.json`), **pairing**, and pairing-reply sends (single
  writer — no cross-session races).
- Maintains the **routing registry**: `topic_id → connected session(s)`, plus
  the `orchestrator` connection.
- Routes each gated update to the right session over IPC.
- **Self-reaps** ~30s after the last client disconnects.

**Singleton guarantee:** binding the Unix socket is the lock. Two sessions
starting at once both try to spawn the broker; the loser's `bind()` fails with
`EADDRINUSE` and it simply connects instead.

### 4.2 Session server (`server.ts`)

Becomes an **IPC client + MCP tool host** (no polling):

- Reads `TELEGRAM_TOPIC` at launch — the role is decided purely from the env
  var, never inferred from traffic:
  - **unset** → **legacy role**: today's single-session behavior, unchanged. No
    orchestrator tools. Routing-wise it is a "hub" (receives DMs + General +
    any topic with no dedicated worker), which for a lone session equals
    receiving everything.
  - **`general`** → **orchestrator role**: the same hub routing as legacy
    (General + DMs + unrouted-topic fallback) **plus** the control tools in §9.
  - **numeric** → **worker role** for that topic.

  Legacy and orchestrator are the same routing "hub"; they differ only in
  whether control tools are exposed. At most one hub (legacy *or* orchestrator)
  may be registered at a time.
- On boot: ensure broker is up (spawn detached if absent), connect to
  `${STATE_DIR}/broker.sock`, send a `register` frame, then translate inbound
  frames into the existing `notifications/claude/channel` events.
- **Outbound stays direct** to the Bot API (sending has no single-consumer
  limit) — no broker hop.

### 4.3 IPC (`ipc.ts`)

Unix domain socket at `${STATE_DIR}/broker.sock`, **newline-delimited JSON**.

Session → broker:

```jsonc
{ "t": "register", "role": "worker"|"orchestrator"|"legacy", "topic_id": 34|null, "pid": 12345 }
{ "t": "heartbeat" }                              // periodic liveness
{ "t": "control", "cmd": "list_sessions" }        // orchestrator only
```

Broker → session:

```jsonc
{ "t": "welcome", "bot_username": "my_bot", "chat_id": "-100123" }
{ "t": "inbound", "content": "...", "meta": { /* see §7 */ } }   // gated + routed
{ "t": "sessions", "sessions": [ /* registry snapshot */ ] }     // control reply
```

Outbound is **not** relayed over IPC. Control frames are honored **only** from
the connection registered as `orchestrator`, and there is **at most one**
orchestrator at a time (a second orchestrator registration is refused).

### 4.4 Shared modules (refactor)

The current 1039-line `server.ts` is doing too much to also host a daemon. Split
the pieces both broker and session need:

- `access.ts` — `Access` type, `loadAccess`/`saveAccess`, `gate`,
  `pruneExpired`, `isMentioned`, static-mode handling.
- `chunk.ts` — the 4096 splitter.
- `richtext.ts` — Rich Message send/edit helpers + capability probe (§8).
- `ipc.ts` — frame types + socket read/write helpers.
- `telegram.ts` — `Bot` construction + shared send helpers.
- `broker.ts` — poller + gate + router + registry + spawn bookkeeping.
- `server.ts` — IPC client + MCP tools.

No unrelated refactoring beyond this split.

## 5. Topic binding

**Env var at launch:** `TELEGRAM_TOPIC=<thread_id> claude --channels plugin:telegram@claude-plugins-official`.

Chosen over a pairing-style "first message claims the session" because it is
deterministic, restart-safe (relaunch re-registers the same topic — no stale
claims), fits the existing `--channels` launch model, and adds no new trust
surface.

**Discovery:** you never hand-hunt numeric ids. An orchestrator/legacy session
receives unclaimed-topic and General messages with `message_thread_id` +
`topic_name` in meta, so Claude can tell you *"that topic is id 34 — launch a
worker with `TELEGRAM_TOPIC=34`"* (or the orchestrator's `spawn_session` does it
for you).

## 6. Routing rules (broker)

For each gated update:

1. `message_thread_id = N` present (`is_topic_message`) → deliver to the worker
   registered for topic `N`. If no worker is registered for `N`, deliver to the
   orchestrator (so nothing is silently dropped) tagged `unrouted: true`.
2. Forum-group message with **no** `message_thread_id` (General topic) → the
   orchestrator.
3. Private chat (DM) → orchestrator if present, else the legacy session.
4. No orchestrator and no matching worker → hold behavior of legacy mode
   (single session gets everything), preserving back-compat.

Gating (pairing/allowlist/group policy/mention) runs **before** routing, exactly
as today. For a dedicated Claude supergroup, recommend `--no-mention` (+ BotFather
privacy off) so every message in a topic reaches its worker without an @mention.

## 7. Inbound meta additions

The `notifications/claude/channel` meta gains:

- `message_thread_id` (string) — present for topic messages.
- `topic_name` (string) — when resolvable from the topic-created service message
  or cached registry.
- `is_general` (bool) — true for General-topic messages.
- `unrouted` (bool) — set when a topic had no worker and the message fell back
  to the orchestrator.

All existing meta fields are unchanged.

## 8. Rich Messages (Bot API 10.1)

grammy `1.41.1` (`@grammyjs/types@3.25.0`) predates 10.1, so `sendRichMessage`
is not typed. Use the untyped raw escape hatch with a local shim:

```ts
// richtext.ts
type InputRichMessage = { markdown: string } | { html: string }
await (bot.api.raw as any).sendRichMessage({
  chat_id, message_thread_id, rich_message: { markdown: text },
})
```

- `reply` gains `format: 'text' | 'markdownv2' | 'rich'`. The **shipped default
  stays `'text'`** for back-compat; server `instructions` recommend `'rich'`.
  When the caller omits `format`, the effective default is `access.json`'s
  `defaultReplyFormat` (§10), which itself defaults to `'text'`.
- **Capability probe + fallback:** on the first `rich` send, if the API errors
  with method-not-found / unsupported, cache `richSupported = false` for the
  process and fall back to the existing markdownv2/text chunker. Logged once to
  stderr.
- **Length:** rich content sends as a single message (its own limit). On a
  length error, fall back to the chunked text path. The 4096 chunker is retained
  for `text`/`markdownv2`.
- `edit_message` gains the same rich path (`editMessageText` accepts
  `rich_message`) for richer progress updates.
- Rich sends are **thread-aware** (`message_thread_id`) like every other send.

## 9. Orchestrator tools (role-gated)

Exposed **only** when the session registered as `orchestrator`:

| Tool | Wraps / does | Notes |
| --- | --- | --- |
| `list_sessions` | broker `control:list_sessions` | Registry snapshot: topic id, role, pid, tmux name, cwd, started_at, last_seen, alive. The "manage in one place" view. |
| `create_topic` | `createForumTopic(name, icon_color?)` | Returns new `message_thread_id` + `t.me` deep link. |
| `edit_topic` / `close_topic` / `reopen_topic` | `editForumTopic` / `closeForumTopic` / `reopenForumTopic` | Thin wraps. |
| `spawn_session` | launch detached worker | `{ topic_id, cwd, name? }`. tmux `tg-<topic_id>` (fallback `nohup`), env `TELEGRAM_TOPIC`. Records pid/tmux/cwd in registry. |
| `stop_session` | kill worker | `{ topic_id }`. Kills tmux session or SIGTERMs pid; broker prunes on disconnect. |

**Cross-topic messaging needs no new tool** — the orchestrator calls `reply`
with `message_thread_id=<n>` to drop a message/task into any topic in the group.

### 9.1 Spawn/stop lifecycle

- `spawn_session` runs, on the host:
  `tmux new-session -d -s tg-<topic_id> -c <cwd> 'TELEGRAM_TOPIC=<topic_id> claude --channels plugin:telegram@claude-plugins-official'`
  falling back to
  `nohup env TELEGRAM_TOPIC=<topic_id> claude --channels … > ${STATE_DIR}/worker-<topic_id>.log 2>&1 &`.
- The worker boots, connects to the broker, registers, and starts receiving its
  topic. pid/tmux name are captured in the registry (persisted to
  `${STATE_DIR}/sessions.json`, broker-owned).
- `stop_session` kills `tg-<topic_id>` (tmux) or SIGTERMs the recorded pid.
- Workers are detached → survive orchestrator/broker restarts and re-register.

### 9.2 Spawn/stop guardrails

Launching Claude in a directory from a Telegram message is powerful, so:

- Honored only from the **orchestrator** connection, whose General-topic sender
  is **allowlisted**.
- **`spawnRoots` is required.** It is an array of absolute path prefixes. If it
  is unset or empty, `spawn_session` refuses outright with an actionable error
  ("configure spawnRoots in access.json to enable spawning"). When set, the
  resolved `cwd` (via `realpath`, symlinks followed) must live under one of the
  roots; anything else is refused. This makes "launch Claude in a directory from
  a chat message" opt-in and bounded by default.
- `cwd` must exist and be a directory.

## 10. Access / config

`access.json` gains optional keys (all defaulted, back-compat):

```jsonc
{
  // ... existing keys unchanged ...
  "spawnRoots": ["/Users/me/projects"],   // REQUIRED for spawn_session; cwd must resolve under a root
  "defaultReplyFormat": "text"             // "text" | "markdownv2" | "rich"
}
```

Env: `TELEGRAM_TOPIC` (new), plus existing `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_STATE_DIR`, `TELEGRAM_ACCESS_MODE`.

Static mode (`TELEGRAM_ACCESS_MODE=static`) unchanged; pairing still downgrades
to allowlist.

## 11. Backwards compatibility

- No `TELEGRAM_TOPIC`, not a forum group → **legacy single-session DM mode**,
  byte-for-byte today's behavior. The broker is still used internally but is
  transparent (one client gets everything).
- `reply` default format stays `text`; nothing changes unless the caller opts
  into `rich` / threads.
- `access.json` without the new keys behaves exactly as before.
- Windows: legacy mode works; multi-session (Unix socket + spawn) is unsupported
  and detected at boot with a clear stderr message.

## 12. Error handling & edge cases

- **Broker dies mid-run:** sessions detect socket close, attempt respawn/reconnect
  with backoff; the winner rebinds the socket, others reconnect. Workers keep
  running; inbound resumes once a broker is back.
- **Two orchestrators:** second registration refused; that session logs and
  behaves as legacy/worker per its env.
- **Topic with no worker:** message falls back to orchestrator tagged
  `unrouted` (never silently dropped).
- **Rich unsupported / too long:** fall back to markdownv2/text chunker.
- **Spawn without tmux:** `nohup` fallback; if neither works, tool returns an
  actionable error.
- **Spawn with `spawnRoots` unset/empty, or `cwd` outside every root:**
  `spawn_session` refuses with an actionable error (never launches).
- **Permission relay:** a worker's permission prompt is sent to **its** topic
  (thread-aware); legacy keeps today's DM broadcast.

## 13. Testing

- **Unit:** `gate` + routing (topic→session mapping, General→orchestrator, DM
  fallback), `chunk`, rich fallback decision, `spawnRoots` validation.
- **Integration (bun test):** stand up a broker with a stub `getUpdates` feed and
  two mock session clients on different topics; inject updates; assert each lands
  at the right client and that an unrouted topic falls back to the orchestrator.
- **Spawn/stop:** stub the launch command; assert registry updates and that
  `stop_session` issues the kill.
- **Manual smoke:** real supergroup with 2 topics + General; verify concurrent
  workers, cross-topic route, `create_topic`, `spawn_session`, and a rich reply
  rendering Markdown.

## 14. File-change summary

- **New:** `broker.ts`, `ipc.ts`, `access.ts`, `chunk.ts`, `richtext.ts`,
  `telegram.ts`, `docs/specs/2026-07-16-threads-orchestrator-design.md`.
- **Changed:** `server.ts` (→ IPC client + tools, orchestrator tools, rich),
  `.mcp.json` (unchanged command; broker spawned by server), `README.md`,
  `ACCESS.md` (topics, orchestrator, rich, `TELEGRAM_TOPIC`, `spawnRoots`),
  `package.json`/`plugin.json` (version bump), configure/access skills (new
  keys/flows).

## 15. Future work

- Streaming rich replies via a dedicated incremental `stream_reply` tool
  (Claude calls it repeatedly; maps to rich `editMessageText`).
- Cross-machine broker (TCP + auth) for distributed workers.
- Orchestrator "feed" mode: opt-in mirror of worker activity into General.
- Rich structural blocks beyond Markdown passthrough (tables/media galleries as
  first-class tool inputs).
```
