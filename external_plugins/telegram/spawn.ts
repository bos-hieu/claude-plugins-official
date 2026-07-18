import { realpathSync, statSync } from 'fs'
import { sep } from 'path'

/**
 * Required-spawnRoots gate: throws unless cwd resolves under a configured root.
 * Returns the RESOLVED realpath — callers MUST spawn with this value (not the raw
 * cwd) so a symlink swapped between validation and launch can't escape the roots.
 */
export function validateCwd(cwd: string, spawnRoots: string[] | undefined): string {
  if (!spawnRoots || spawnRoots.length === 0) {
    throw new Error('spawn refused: configure "spawnRoots" in access.json to enable spawning worker sessions')
  }
  let real: string
  try { real = realpathSync(cwd) } catch { throw new Error(`spawn refused: cwd does not exist: ${cwd}`) }
  let isDir: boolean
  try { isDir = statSync(real).isDirectory() } catch { throw new Error(`spawn refused: cannot stat cwd: ${cwd}`) }
  if (!isDir) throw new Error(`spawn refused: cwd is not a directory: ${cwd}`)
  const ok = spawnRoots.some(root => {
    let r: string
    try { r = realpathSync(root) } catch { return false }
    return real === r || real.startsWith(r + sep)
  })
  if (!ok) throw new Error(`spawn refused: cwd not under any spawnRoots entry: ${cwd}`)
  return real
}

export type SpawnCmd = { file: string; args: string[] }

/**
 * Build the launch command for a worker session. The caller MUST apply the
 * (validated, resolved) cwd via child_process spawn's `{ cwd }` option.
 *
 * cwd is NEVER interpolated into a shell string here — a directory name
 * containing shell metacharacters ($(), backticks, ;) could otherwise inject.
 * topicId is a number, safe to interpolate. In the tmux branch cwd is a
 * distinct argv element (`-c <cwd>`), not shell-parsed.
 */
export function buildSpawnCommand(p: { topicId: number; cwd: string; useTmux: boolean }): SpawnCmd {
  const inner = `TELEGRAM_TOPIC=${p.topicId} claude --channels plugin:telegram@claude-plugins-official`
  if (p.useTmux) {
    return { file: 'tmux', args: ['new-session', '-d', '-s', `tg-${p.topicId}`, '-c', p.cwd, inner] }
  }
  // nohup branch: cwd comes from spawn's { cwd } option, not the command string.
  return { file: 'sh', args: ['-c', `nohup ${inner} > worker-${p.topicId}.log 2>&1 &`] }
}
