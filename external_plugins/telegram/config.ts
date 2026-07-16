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
