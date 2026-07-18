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
