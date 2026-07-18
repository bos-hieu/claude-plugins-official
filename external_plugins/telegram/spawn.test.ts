import { expect, test } from 'bun:test'
import { mkdtempSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { validateCwd, buildSpawnCommand } from './spawn'

function tmp() { return mkdtempSync(join(tmpdir(), 'tg-spawn-')) }

test('validateCwd refuses when spawnRoots is unset/empty', () => {
  const dir = tmp()
  expect(() => validateCwd(dir, undefined)).toThrow(/spawnRoots/)
  expect(() => validateCwd(dir, [])).toThrow(/spawnRoots/)
})

test('validateCwd refuses a cwd outside every root', () => {
  const root = tmp()
  const other = tmp()
  expect(() => validateCwd(other, [root])).toThrow(/not under/)
})

test('validateCwd accepts a cwd under a root and returns its realpath', () => {
  const root = tmp()
  expect(validateCwd(root, [root])).toBe(realpathSync(root))
})

test('buildSpawnCommand uses tmux with env and cwd', () => {
  const cmd = buildSpawnCommand({ topicId: 34, cwd: '/x', useTmux: true })
  expect(cmd.file).toBe('tmux')
  expect(cmd.args.join(' ')).toContain('tg-34')
  expect(cmd.args.join(' ')).toContain('TELEGRAM_TOPIC=34')
})

test('buildSpawnCommand nohup branch never interpolates cwd into the shell string', () => {
  const cmd = buildSpawnCommand({ topicId: 7, cwd: '/tmp/$(whoami)`id`', useTmux: false })
  expect(cmd.file).toBe('sh')
  const joined = cmd.args.join(' ')
  expect(joined).not.toContain('whoami')
  expect(joined).not.toContain('$(')
  expect(joined).toContain('TELEGRAM_TOPIC=7')
})
