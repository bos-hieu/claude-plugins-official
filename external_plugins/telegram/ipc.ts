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
