# Telegram

Connect a Telegram bot to your Claude Code with an MCP server.

The MCP server logs into Telegram as a bot and provides tools to Claude to reply, react, or edit messages. When you message the bot, the server forwards the message to your Claude Code session.

## Prerequisites

- [Bun](https://bun.sh) — the MCP server runs on Bun. Install with `curl -fsSL https://bun.sh/install | bash`.

## Quick Setup
> Default pairing flow for a single-user DM bot. See [ACCESS.md](./ACCESS.md) for groups and multi-user setups.

**1. Create a bot with BotFather.**

Open a chat with [@BotFather](https://t.me/BotFather) on Telegram and send `/newbot`. BotFather asks for two things:

- **Name** — the display name shown in chat headers (anything, can contain spaces)
- **Username** — a unique handle ending in `bot` (e.g. `my_assistant_bot`). This becomes your bot's link: `t.me/my_assistant_bot`.

BotFather replies with a token that looks like `123456789:AAHfiqksKZ8...` — that's the whole token, copy it including the leading number and colon.

**2. Install the plugin.**

These are Claude Code commands — run `claude` to start a session first.

Install the plugin:
```
/plugin install telegram@claude-plugins-official
/reload-plugins
```

**3. Give the server the token.**

```
/telegram:configure 123456789:AAHfiqksKZ8...
```

Writes `TELEGRAM_BOT_TOKEN=...` to `~/.claude/channels/telegram/.env`. You can also write that file by hand, or set the variable in your shell environment — shell takes precedence.

> To run multiple bots on one machine (different tokens, separate allowlists), point `TELEGRAM_STATE_DIR` at a different directory per instance.

**4. Relaunch with the channel flag.**

The server won't connect without this — exit your session and start a new one:

```sh
claude --channels plugin:telegram@claude-plugins-official
```

**5. Pair.**

With Claude Code running from the previous step, DM your bot on Telegram — it replies with a 6-character pairing code. If the bot doesn't respond, make sure your session is running with `--channels`. In your Claude Code session:

```
/telegram:access pair <code>
```

Your next DM reaches the assistant.

> Unlike Discord, there's no server invite step — Telegram bots accept DMs immediately. Pairing handles the user-ID lookup so you never touch numeric IDs.

**6. Lock it down.**

Pairing is for capturing IDs. Once you're in, switch to `allowlist` so strangers don't get pairing-code replies. Ask Claude to do it, or `/telegram:access policy allowlist` directly.

## Multiple sessions & forum topics

One bot can serve many concurrent Claude Code sessions, routed by Telegram **forum topics** in a supergroup. A single **broker daemon** (one per `TELEGRAM_STATE_DIR`) owns the bot's `getUpdates` poll, gates inbound messages through access control, and hands each one to the session that claimed its topic over a Unix-domain socket (`broker.sock`). It's spawned automatically by the first session that starts, and self-reaps ~30s after the last connected session exits. This is single-host only — the broker and every session it serves must run on the same machine.

Sessions still reply directly to Telegram; only inbound polling goes through the broker.

A session's role is chosen at launch with the `TELEGRAM_TOPIC` env var:

| `TELEGRAM_TOPIC` | Role |
| --- | --- |
| unset | **Legacy** — today's single-session behavior, unchanged |
| `general` | **Orchestrator** — the General-topic control session |
| a numeric topic id | **Worker** — bound to that forum topic |

```sh
# orchestrator (General topic)
TELEGRAM_TOPIC=general claude --channels plugin:telegram@claude-plugins-official

# worker bound to topic 34
TELEGRAM_TOPIC=34 claude --channels plugin:telegram@claude-plugins-official
```

The orchestrator coordinates the other sessions: `list_sessions` to see who's connected and to which topic, `create_topic`/`edit_topic`/`close_topic`/`reopen_topic` to manage the forum's topics, and `spawn_session`/`stop_session` to launch or tear down workers. It can also route work into any topic directly by calling `reply` with that topic's `message_thread_id`.

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, groups, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are **numeric user IDs** (get yours from [@userinfobot](https://t.me/userinfobot)). Default policy is `pairing`. `ackReaction` only accepts Telegram's fixed emoji whitelist.

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a chat. Takes `chat_id` + `text`, optionally `reply_to` (message ID) for native threading, `message_thread_id` to send into a specific forum topic, `format: 'rich'` to render Claude's Markdown natively (auto-falls back to plain text if the bot/API doesn't support Rich Messages; default stays `text`), and `files` (absolute paths) for attachments. Images (`.jpg`/`.png`/`.gif`/`.webp`) send as photos with inline preview; other types send as documents. Max 50MB each. Auto-chunks text; files send as separate messages after the text. Returns the sent message ID(s). |
| `react` | Add an emoji reaction to a message by ID. **Only Telegram's fixed whitelist** is accepted (👍 👎 ❤ 🔥 👀 etc). |
| `edit_message` | Edit a message the bot previously sent. Useful for "working…" → result progress updates. Also accepts `format: 'rich'`. Only works on the bot's own messages. |

The `general`-topic (orchestrator) session additionally gets: `list_sessions`, `create_topic`/`edit_topic`/`close_topic`/`reopen_topic`, and `spawn_session`/`stop_session`.

Inbound messages trigger a typing indicator automatically — Telegram shows
"botname is typing…" while the assistant works on a response.

## Rich Messages

With Bot API 10.1, `reply` and `edit_message` accept `format: 'rich'`, which renders Claude's Markdown — headings, code blocks, lists, tables — natively in Telegram instead of falling back to plain text. If the bot or the Telegram client doesn't support Rich Messages, it automatically falls back to plain text. The default format is unchanged (`text`).

## Photos

Inbound photos are downloaded to `~/.claude/channels/telegram/inbox/` and the
local path is included in the `<channel>` notification so the assistant can
`Read` it. Telegram compresses photos — if you need the original file, send it
as a document instead (long-press → Send as File).

## No history or search

Telegram's Bot API exposes **neither** message history nor search. The bot
only sees messages as they arrive — no `fetch_messages` tool exists. If the
assistant needs earlier context, it will ask you to paste or summarize.

This also means there's no `download_attachment` tool for historical messages
— photos are downloaded eagerly on arrival since there's no way to fetch them
later.

## Contributing

Multi-session forum topics, the General-topic orchestrator, and Bot API 10.1
rich-message support (v0.2.0) were contributed by
[@bos-hieu](https://github.com/bos-hieu).

Contributions are welcome. The MCP server is a single Bun/TypeScript codebase
under `external_plugins/telegram/`; run the test suite with `bun test` from that
directory (unit tests cover config, gating, chunking, IPC framing, routing,
rich-message fallback, and spawn validation). Please keep the legacy single-user
DM path working (`TELEGRAM_TOPIC` unset) and add tests for new behavior. See
[CHANGELOG.md](./CHANGELOG.md) for the release history.
