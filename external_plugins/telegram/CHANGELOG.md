# Changelog

All notable changes to the Telegram plugin are documented here.

## 0.1.0

Multi-session, forum topics, orchestrator, and rich messages.

### Added
- **Multiple concurrent sessions on one bot**, routed by Telegram forum topics.
  A detached **broker daemon** (one per `TELEGRAM_STATE_DIR`) owns the single
  `getUpdates` poll, gates messages, and routes each to the session that claimed
  its topic over a Unix-domain socket. Auto-spawned by the first session,
  self-reaps ~30s after the last disconnects. Single-host (POSIX).
- **Role selection via `TELEGRAM_TOPIC`**: unset = legacy (unchanged single
  session), `general` = orchestrator, numeric = worker bound to that topic.
- **General-topic orchestrator tools** (exposed only to the `general` session):
  `list_sessions`, `create_topic`/`edit_topic`/`close_topic`/`reopen_topic`,
  and `spawn_session`/`stop_session`. Route work into any topic by calling
  `reply` with its `message_thread_id`.
- **Bot API 10.1 Rich Messages**: `reply`/`edit_message` accept `format: 'rich'`
  to render Claude's Markdown (headings, code, tables, lists) natively, with
  automatic fallback to plain text when unsupported.
- **Thread-aware outbound**: `reply` accepts `message_thread_id`; a worker
  threads back to its bound topic automatically, and worker permission prompts
  are delivered into that worker's topic.
- New `access.json` keys: `spawnRoots` (required allowlist of absolute path
  prefixes gating `spawn_session`) and `defaultReplyFormat`
  (`text`|`markdownv2`|`rich`). Settable via `/telegram:access set`.

### Changed
- `server.ts` is now a broker IPC client (no longer polls Telegram directly);
  the polling/gating/pairing stack moved into the broker. Access/gating,
  chunking, framing, routing, rich-text, and spawn logic were split into focused
  modules (`access.ts`, `chunk.ts`, `ipc.ts`, `routing.ts`, `richtext.ts`,
  `spawn.ts`, `config.ts`).

### Security
- `spawn_session` refuses unless `spawnRoots` is configured and the requested
  cwd resolves under a configured root; the resolved realpath (not the raw
  argument) is used for launch, closing a symlink-swap window. The working
  directory is never interpolated into a shell string.
- Orchestrator tools are gated both at registration and per-call (defense in
  depth); a non-orchestrator session refuses them even if invoked directly.

### Compatibility
- With `TELEGRAM_TOPIC` unset and no forum topics, behavior is unchanged from
  0.0.6 — the broker runs transparently and a single session receives everything.
- Multi-session (Unix socket + spawn) is POSIX/single-host; legacy DM mode still
  works on Windows.

## 0.0.6 and earlier

Single-user DM/group bridge with pairing, allowlists, group mention-triggering,
reply/react/edit tools, and attachment handling. See git history.
