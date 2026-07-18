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
