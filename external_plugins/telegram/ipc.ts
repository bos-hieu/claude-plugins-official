import { StringDecoder } from 'string_decoder'

const MAX_LINE_BYTES = 8 * 1024 * 1024 // drop a pathological never-terminated line

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
  permission?: { request_id: string; behavior: 'allow' | 'deny' }
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
  | { t: 'inbound'; content: string; meta: SessionMeta }
  | { t: 'sessions'; sessions: SessionInfo[] }
  | { t: 'error'; message: string }

export function encodeFrame(f: SessionFrame | BrokerFrame): string {
  return JSON.stringify(f) + '\n'
}

/** Reassembles newline-delimited JSON frames from arbitrary byte chunks. */
export class LineDecoder<T> {
  private buf = ''
  private decoder = new StringDecoder('utf8')
  constructor(private onFrame: (f: T) => void) {}
  push(chunk: Buffer | string): void {
    // StringDecoder.write holds back any incomplete trailing multi-byte
    // sequence until the next chunk completes it — decoding each Buffer
    // independently would corrupt characters that straddle a chunk boundary.
    this.buf += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
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
    if (this.buf.length > MAX_LINE_BYTES) this.buf = '' // never-terminated line: drop
  }
}
