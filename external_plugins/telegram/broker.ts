import net from 'net'
import { existsSync, rmSync, writeFileSync, readFileSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { Bot, GrammyError, InlineKeyboard, type Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { encodeFrame, LineDecoder, type SessionFrame, type SessionInfo, type SessionMeta } from './ipc'
import { routeTarget, type Registry, type RegEntry, type RouteInput } from './routing'
import { TOKEN, SOCK_FILE, STATE_DIR, APPROVED_DIR, PID_FILE, INBOX_DIR, STATIC } from './config'
import { gate, dmCommandGate, loadAccess } from './access'

export type BrokerConn = {
  socket: net.Socket
  key: string | null
  info: SessionInfo | null
}

export type Broker = {
  registry: Registry
  conns: Set<BrokerConn>
  connByKey: Map<string, BrokerConn>
  idleSince: number | null
  stop: () => Promise<void>
}

export type BrokerOpts = { sockPath: string; poll: boolean }

// exported for Task 7 to attach the poller/router
export const HUB_ROLES = new Set(['orchestrator', 'legacy'])

// Permission-reply spec from anthropics/claude-cli-internal
// src/services/mcp/channelPermissions.ts — inlined (no CC repo dep).
// 5 lowercase letters a-z minus 'l'. Case-insensitive for phone autocorrect.
// Strict: no bare yes/no (conversational), no prefix/suffix chatter.
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

/** Push a gated message to the correct session. Exported for tests. */
export function deliverInbound(broker: Broker, meta: SessionMeta, content: string, input: RouteInput): void {
  const target = routeTarget(input, broker.registry)
  if (target.kind === 'drop') return
  const conn = broker.connByKey.get(target.key)
  if (!conn) return
  const finalMeta = target.unrouted ? { ...meta, unrouted: true } : meta
  conn.socket.write(encodeFrame({ t: 'inbound', content, meta: finalMeta }))
}

export async function startBroker(opts: BrokerOpts): Promise<Broker> {
  const registry: Registry = new Map()
  const conns = new Set<BrokerConn>()
  const connByKey = new Map<string, BrokerConn>()
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
      if (conn.key) { registry.delete(conn.key); infoByKey.delete(conn.key); connByKey.delete(conn.key) }
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
        if (conn.key) connByKey.delete(conn.key)
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
      connByKey.set(key, conn)
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

  // Assigned by startPolling() below; lets broker.stop() halt the bot + PID file.
  let stopPolling: (() => void) | null = null

  const broker: Broker = {
    registry, conns, connByKey, idleSince: null,
    stop: () => new Promise<void>(res => {
      stopPolling?.()
      // server.close() only fires once every connection has ended, so tear the
      // live sockets down first — otherwise stop() hangs while workers stay open.
      for (const conn of conns) conn.socket.destroy()
      server.close(() => { rmSync(opts.sockPath, { force: true }); res() })
    }),
  }

  // ── Telegram polling stack ────────────────────────────────────────────────
  // Only the broker polls getUpdates (one consumer per token). Inbound messages
  // are gated then routed to the matching session via deliverInbound.
  function startPolling(broker: Broker): void {
    const bot = new Bot(TOKEN!)
    let botUsername = ''
    let shuttingDown = false

    // Telegram allows exactly one getUpdates consumer per token. If a previous
    // broker crashed (SIGKILL, terminal closed) it can survive as an orphan and
    // hold the slot forever, so every new broker sees 409 Conflict. Kill any
    // stale holder before we start polling.
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    try {
      const stale = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
      if (stale > 1 && stale !== process.pid) {
        process.kill(stale, 0)
        process.stderr.write(`telegram broker: replacing stale poller pid=${stale}\n`)
        process.kill(stale, 'SIGTERM')
      }
    } catch {}
    writeFileSync(PID_FILE, String(process.pid))

    // Halts polling and releases the PID file. Wired into broker.stop() so a
    // signal or self-reap stops the getUpdates loop cleanly.
    stopPolling = () => {
      if (shuttingDown) return
      shuttingDown = true
      try {
        if (parseInt(readFileSync(PID_FILE, 'utf8'), 10) === process.pid) rmSync(PID_FILE)
      } catch {}
      void Promise.resolve(bot.stop()).catch(() => {})
    }

    // Watchdog: if another broker took over the PID file, stand down to avoid a
    // 409 tug-of-war over the token. (Replaces server.ts's stdin/ppid orphan
    // watchdog, which is meaningless for a detached daemon — idle self-reap in
    // the entrypoint handles the "nobody needs me" case.)
    setInterval(() => {
      let owner: number
      try { owner = parseInt(readFileSync(PID_FILE, 'utf8'), 10) } catch { return }
      if (owner !== process.pid) stopPolling?.()
    }, 5000).unref()

    // Permission-request details for "See more" expansion live in server.ts
    // (the MCP process that received the request). The broker only sees button
    // presses, so this map stays empty here — "See more" degrades to a
    // "details no longer available" notice until a later task plumbs details
    // over IPC.
    const pendingPermissions = new Map<string, { tool_name: string; description: string; input_preview: string }>()

    // The /telegram:access skill drops a file at approved/<senderId> when it
    // pairs someone. Poll for it, send confirmation, clean up. For Telegram
    // DMs, chatId == senderId, so we can send directly without stashing chatId.
    function checkApprovals(): void {
      let files: string[]
      try {
        files = readdirSync(APPROVED_DIR)
      } catch {
        return
      }
      if (files.length === 0) return

      for (const senderId of files) {
        const file = join(APPROVED_DIR, senderId)
        void bot.api.sendMessage(senderId, "Paired! Say hi to Claude.").then(
          () => rmSync(file, { force: true }),
          err => {
            process.stderr.write(`telegram channel: failed to send approval confirm: ${err}\n`)
            // Remove anyway — don't loop on a broken send.
            rmSync(file, { force: true })
          },
        )
      }
    }

    if (!STATIC) setInterval(checkApprovals, 5000).unref()

    // Commands are DM-only. Responding in groups would: (1) leak pairing codes
    // via /status to other group members, (2) confirm bot presence in
    // non-allowlisted groups, (3) spam channels the operator never approved.
    // Silent drop matches the gate's behavior for unrecognized groups.

    bot.command('start', async ctx => {
      if (!dmCommandGate(ctx)) return
      await ctx.reply(
        `This bot bridges Telegram to a Claude Code session.\n\n` +
        `To pair:\n` +
        `1. DM me anything — you'll get a 6-char code\n` +
        `2. In Claude Code: /telegram:access pair <code>\n\n` +
        `After that, DMs here reach that session.`
      )
    })

    bot.command('help', async ctx => {
      if (!dmCommandGate(ctx)) return
      await ctx.reply(
        `Messages you send here route to a paired Claude Code session. ` +
        `Text and photos are forwarded; replies and reactions come back.\n\n` +
        `/start — pairing instructions\n` +
        `/status — check your pairing state`
      )
    })

    bot.command('status', async ctx => {
      const gated = dmCommandGate(ctx)
      if (!gated) return
      const { access, senderId } = gated

      if (access.allowFrom.includes(senderId)) {
        const name = ctx.from!.username ? `@${ctx.from!.username}` : senderId
        await ctx.reply(`Paired as ${name}.`)
        return
      }

      for (const [code, p] of Object.entries(access.pending)) {
        if (p.senderId === senderId) {
          await ctx.reply(
            `Pending pairing — run in Claude Code:\n\n/telegram:access pair ${code}`
          )
          return
        }
      }

      await ctx.reply(`Not paired. Send me a message to get a pairing code.`)
    })

    // Inline-button handler for permission requests. Callback data is
    // `perm:allow:<id>`, `perm:deny:<id>`, or `perm:more:<id>`.
    // Security mirrors the text-reply path: allowFrom must contain the sender.
    bot.on('callback_query:data', async ctx => {
      const data = ctx.callbackQuery.data
      const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(data)
      if (!m) {
        await ctx.answerCallbackQuery().catch(() => {})
        return
      }
      const access = loadAccess()
      const senderId = String(ctx.from.id)
      if (!access.allowFrom.includes(senderId)) {
        await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
        return
      }
      const [, behavior, request_id] = m

      if (behavior === 'more') {
        const details = pendingPermissions.get(request_id)
        if (!details) {
          await ctx.answerCallbackQuery({ text: 'Details no longer available.' }).catch(() => {})
          return
        }
        const { tool_name, description, input_preview } = details
        let prettyInput: string
        try {
          prettyInput = JSON.stringify(JSON.parse(input_preview), null, 2)
        } catch {
          prettyInput = input_preview
        }
        const expanded =
          `🔐 Permission: ${tool_name}\n\n` +
          `tool_name: ${tool_name}\n` +
          `description: ${description}\n` +
          `input_preview:\n${prettyInput}`
        const keyboard = new InlineKeyboard()
          .text('✅ Allow', `perm:allow:${request_id}`)
          .text('❌ Deny', `perm:deny:${request_id}`)
        await ctx.editMessageText(expanded, { reply_markup: keyboard }).catch(() => {})
        await ctx.answerCallbackQuery().catch(() => {})
        return
      }

      // Route the verdict to the session that owns the topic the prompt was
      // posted in — the callback message carries the same message_thread_id the
      // worker sent the prompt into. Falling back to null (→ hub) covers DM/
      // General prompts. Must mirror the text-reply path below, else a worker's
      // Allow/Deny tap would hang its tool call.
      deliverInbound(
        broker,
        { chat_id: String(ctx.chat!.id), permission: { request_id, behavior: behavior as 'allow' | 'deny' } },
        '',
        { thread_id: ctx.callbackQuery.message?.message_thread_id ?? null, is_private: ctx.chat?.type === 'private' },
      )
      pendingPermissions.delete(request_id)
      const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
      await ctx.answerCallbackQuery({ text: label }).catch(() => {})
      // Replace buttons with the outcome so the same request can't be answered
      // twice and the chat history shows what was chosen.
      const msg = ctx.callbackQuery.message
      if (msg && 'text' in msg && msg.text) {
        await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {})
      }
    })

    bot.on('message:text', async ctx => {
      await handleInbound(ctx, ctx.message.text, undefined)
    })

    bot.on('message:photo', async ctx => {
      const caption = ctx.message.caption ?? '(photo)'
      // Defer download until after the gate approves — any user can send photos,
      // and we don't want to burn API quota or fill the inbox for dropped messages.
      await handleInbound(ctx, caption, async () => {
        // Largest size is last in the array.
        const photos = ctx.message.photo
        const best = photos[photos.length - 1]
        try {
          const file = await ctx.api.getFile(best.file_id)
          if (!file.file_path) return undefined
          const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
          const res = await fetch(url)
          const buf = Buffer.from(await res.arrayBuffer())
          const ext = file.file_path.split('.').pop() ?? 'jpg'
          const path = join(INBOX_DIR, `${Date.now()}-${best.file_unique_id}.${ext}`)
          mkdirSync(INBOX_DIR, { recursive: true })
          writeFileSync(path, buf)
          return path
        } catch (err) {
          process.stderr.write(`telegram channel: photo download failed: ${err}\n`)
          return undefined
        }
      })
    })

    bot.on('message:document', async ctx => {
      const doc = ctx.message.document
      const name = safeName(doc.file_name)
      const text = ctx.message.caption ?? `(document: ${name ?? 'file'})`
      await handleInbound(ctx, text, undefined, {
        kind: 'document',
        file_id: doc.file_id,
        size: doc.file_size,
        mime: doc.mime_type,
        name,
      })
    })

    bot.on('message:voice', async ctx => {
      const voice = ctx.message.voice
      const text = ctx.message.caption ?? '(voice message)'
      await handleInbound(ctx, text, undefined, {
        kind: 'voice',
        file_id: voice.file_id,
        size: voice.file_size,
        mime: voice.mime_type,
      })
    })

    bot.on('message:audio', async ctx => {
      const audio = ctx.message.audio
      const name = safeName(audio.file_name)
      const text = ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? 'audio'})`
      await handleInbound(ctx, text, undefined, {
        kind: 'audio',
        file_id: audio.file_id,
        size: audio.file_size,
        mime: audio.mime_type,
        name,
      })
    })

    bot.on('message:video', async ctx => {
      const video = ctx.message.video
      const text = ctx.message.caption ?? '(video)'
      await handleInbound(ctx, text, undefined, {
        kind: 'video',
        file_id: video.file_id,
        size: video.file_size,
        mime: video.mime_type,
        name: safeName(video.file_name),
      })
    })

    bot.on('message:video_note', async ctx => {
      const vn = ctx.message.video_note
      await handleInbound(ctx, '(video note)', undefined, {
        kind: 'video_note',
        file_id: vn.file_id,
        size: vn.file_size,
      })
    })

    bot.on('message:sticker', async ctx => {
      const sticker = ctx.message.sticker
      const emoji = sticker.emoji ? ` ${sticker.emoji}` : ''
      await handleInbound(ctx, `(sticker${emoji})`, undefined, {
        kind: 'sticker',
        file_id: sticker.file_id,
        size: sticker.file_size,
      })
    })

    type AttachmentMeta = {
      kind: string
      file_id: string
      size?: number
      mime?: string
      name?: string
    }

    // Filenames and titles are uploader-controlled. They land inside the
    // <channel> notification — delimiter chars would let the uploader break out
    // of the tag or forge a second meta entry.
    function safeName(s: string | undefined): string | undefined {
      return s?.replace(/[<>\[\]\r\n;]/g, '_')
    }

    async function handleInbound(
      ctx: Context,
      text: string,
      downloadImage: (() => Promise<string | undefined>) | undefined,
      attachment?: AttachmentMeta,
    ): Promise<void> {
      const result = gate(ctx, botUsername)

      if (result.action === 'drop') return

      if (result.action === 'pair') {
        const lead = result.isResend ? 'Still pending' : 'Pairing required'
        await ctx.reply(
          `${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`,
        )
        return
      }

      const access = result.access
      const chat_id = String(ctx.chat!.id)
      const msgId = ctx.message?.message_id

      // Permission-reply intercept: if this looks like "yes xxxxx" for a
      // pending permission request, deliver the verdict to the session instead
      // of relaying as chat. The sender is already gate()-approved at this point
      // (non-allowlisted senders were dropped above), so we trust the reply.
      const permMatch = PERMISSION_REPLY_RE.exec(text)
      if (permMatch) {
        const input: RouteInput = { thread_id: ctx.message?.message_thread_id ?? null, is_private: ctx.chat?.type === 'private' }
        deliverInbound(
          broker,
          {
            chat_id,
            permission: {
              request_id: permMatch[2]!.toLowerCase(),
              behavior: permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
            },
          },
          '',
          input,
        )
        if (msgId != null) {
          const emoji = permMatch[1]!.toLowerCase().startsWith('y') ? '✅' : '❌'
          void bot.api.setMessageReaction(chat_id, msgId, [
            { type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] },
          ]).catch(() => {})
        }
        return
      }

      // Typing indicator — signals "processing" until we reply (or ~5s elapses).
      void bot.api.sendChatAction(chat_id, 'typing').catch(() => {})

      // Ack reaction — lets the user know we're processing. Fire-and-forget.
      // Telegram only accepts a fixed emoji whitelist — if the user configures
      // something outside that set the API rejects it and we swallow.
      if (access.ackReaction && msgId != null) {
        void bot.api
          .setMessageReaction(chat_id, msgId, [
            { type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] },
          ])
          .catch(() => {})
      }

      const imagePath = downloadImage ? await downloadImage() : undefined

      const chatType = ctx.chat?.type
      const threadId = ctx.message?.message_thread_id ?? null
      const isGeneral = (chatType === 'supergroup' || chatType === 'group') && threadId == null
      const input: RouteInput = { thread_id: threadId, is_private: chatType === 'private' }
      // image_path goes in meta only — an in-content "[image attached — read: PATH]"
      // annotation is forgeable by any allowlisted sender typing that string.
      const meta: SessionMeta = {
        chat_id,
        message_id: ctx.message ? String(ctx.message.message_id) : undefined,
        user: ctx.from?.username ?? String(ctx.from?.id),
        user_id: String(ctx.from?.id),
        ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
        message_thread_id: threadId != null ? String(threadId) : undefined,
        is_general: isGeneral || undefined,
        ...(imagePath ? { image_path: imagePath } : {}),
        ...(attachment ? {
          attachment_kind: attachment.kind,
          attachment_file_id: attachment.file_id,
          ...(attachment.size != null ? { attachment_size: String(attachment.size) } : {}),
          ...(attachment.mime ? { attachment_mime: attachment.mime } : {}),
          ...(attachment.name ? { attachment_name: attachment.name } : {}),
        } : {}),
      }
      deliverInbound(broker, meta, text, input)
    }

    // Without this, any throw in a message handler stops polling permanently
    // (grammy's default error handler calls bot.stop() and rethrows).
    bot.catch(err => {
      process.stderr.write(`telegram channel: handler error (polling continues): ${err.error}\n`)
    })

    // Retry polling with backoff on any error. Previously only 409 was retried —
    // a single ETIMEDOUT/ECONNRESET/DNS failure rejected bot.start(), the catch
    // returned, and polling stopped permanently while the process stayed alive.
    // Outbound tools kept working but the bot was deaf to inbound messages until
    // a full restart.
    void (async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          await bot.start({
            onStart: info => {
              attempt = 0
              botUsername = info.username
              process.stderr.write(`telegram channel: polling as @${info.username}\n`)
              void bot.api.setMyCommands(
                [
                  { command: 'start', description: 'Welcome and setup guide' },
                  { command: 'help', description: 'What this bot can do' },
                  { command: 'status', description: 'Check your pairing status' },
                ],
                { scope: { type: 'all_private_chats' } },
              ).catch(() => {})
            },
          })
          return // bot.stop() was called — clean exit from the loop
        } catch (err) {
          if (shuttingDown) return
          // bot.stop() mid-setup rejects with grammy's "Aborted delay" — expected, not an error.
          if (err instanceof Error && err.message === 'Aborted delay') return
          const is409 = err instanceof GrammyError && err.error_code === 409
          if (is409 && attempt >= 8) {
            process.stderr.write(
              `telegram channel: 409 Conflict persists after ${attempt} attempts — ` +
              `another poller is holding the bot token (stray broker process or a second session). Exiting.\n`,
            )
            return
          }
          const delay = Math.min(1000 * attempt, 15000)
          const detail = is409
            ? `409 Conflict${attempt === 1 ? ' — another instance is polling (zombie session, or a second Claude Code running?)' : ''}`
            : `polling error: ${err}`
          process.stderr.write(`telegram channel: ${detail}, retrying in ${delay / 1000}s\n`)
          await new Promise(r => setTimeout(r, delay))
        }
      }
    })()
  }

  if (opts.poll) startPolling(broker)
  return broker
}

if (import.meta.main) {
  if (!TOKEN) { process.stderr.write('broker: TELEGRAM_BOT_TOKEN required\n'); process.exit(1) }
  const broker = await startBroker({ sockPath: SOCK_FILE, poll: true })
  setInterval(() => {
    if (broker.conns.size === 0) {
      if (broker.idleSince == null) broker.idleSince = Date.now()
      else if (Date.now() - broker.idleSince > 30_000) { void broker.stop().then(() => process.exit(0)) }
    } else broker.idleSince = null
  }, 5000).unref()
  process.on('SIGTERM', () => void broker.stop().then(() => process.exit(0)))
  process.on('SIGINT', () => void broker.stop().then(() => process.exit(0)))
}
