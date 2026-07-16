import { expect, test } from 'bun:test'
import { defaultAccess, pruneExpired, isMentioned } from './access'

test('defaultAccess is pairing with empty lists', () => {
  const a = defaultAccess()
  expect(a.dmPolicy).toBe('pairing')
  expect(a.allowFrom).toEqual([])
  expect(a.groups).toEqual({})
})

test('pruneExpired removes past-due pending codes', () => {
  const a = defaultAccess()
  a.pending['dead'] = { senderId: '1', chatId: '1', createdAt: 0, expiresAt: 1, replies: 1 }
  a.pending['live'] = { senderId: '2', chatId: '2', createdAt: 0, expiresAt: 2 ** 53, replies: 1 }
  expect(pruneExpired(a)).toBe(true)
  expect(Object.keys(a.pending)).toEqual(['live'])
})

test('isMentioned matches a reply to the bot', () => {
  const ctx: any = { message: { reply_to_message: { from: { username: 'mybot' } }, entities: [], text: 'hi' } }
  expect(isMentioned(ctx, 'mybot')).toBe(true)
  expect(isMentioned(ctx, 'otherbot')).toBe(false)
})
