import { expect, test } from 'bun:test'
import { parseBinding } from './config'

test('unset TELEGRAM_TOPIC → legacy', () => {
  expect(parseBinding(undefined)).toEqual({ role: 'legacy', topicId: null })
  expect(parseBinding('')).toEqual({ role: 'legacy', topicId: null })
})

test('general → orchestrator (case-insensitive)', () => {
  expect(parseBinding('general')).toEqual({ role: 'orchestrator', topicId: null })
  expect(parseBinding('General')).toEqual({ role: 'orchestrator', topicId: null })
})

test('numeric → worker for that topic', () => {
  expect(parseBinding('34')).toEqual({ role: 'worker', topicId: 34 })
})

test('invalid value throws', () => {
  expect(() => parseBinding('not-a-topic')).toThrow()
  expect(() => parseBinding('-5')).toThrow()
})
