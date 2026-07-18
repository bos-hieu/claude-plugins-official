import { expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
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

test('validateCwd accepts a cwd under a root', () => {
  const root = tmp()
  expect(validateCwd(root, [root])).toBe(true)
})

test('buildSpawnCommand uses tmux with env and cwd', () => {
  const cmd = buildSpawnCommand({ topicId: 34, cwd: '/x', useTmux: true })
  expect(cmd.file).toBe('tmux')
  expect(cmd.args.join(' ')).toContain('tg-34')
  expect(cmd.args.join(' ')).toContain('TELEGRAM_TOPIC=34')
})
