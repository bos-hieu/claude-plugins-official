import { expect, test } from 'bun:test'
import { routeTarget, type Registry } from './routing'

test('topic message goes to its worker', () => {
  const r: Registry = new Map([['worker:34', { role: 'worker', topic_id: 34 }]])
  expect(routeTarget({ thread_id: 34, is_private: false }, r)).toEqual({ kind: 'deliver', key: 'worker:34' })
})

test('topic with no worker falls back to hub as unrouted', () => {
  const r: Registry = new Map([['hub', { role: 'orchestrator', topic_id: null }]])
  expect(routeTarget({ thread_id: 99, is_private: false }, r)).toEqual({ kind: 'deliver', key: 'hub', unrouted: true })
})

test('general (no thread) goes to hub', () => {
  const r: Registry = new Map([['hub', { role: 'legacy', topic_id: null }]])
  expect(routeTarget({ thread_id: null, is_private: false }, r)).toEqual({ kind: 'deliver', key: 'hub' })
})

test('DM goes to hub', () => {
  const r: Registry = new Map([['hub', { role: 'orchestrator', topic_id: null }]])
  expect(routeTarget({ thread_id: null, is_private: true }, r)).toEqual({ kind: 'deliver', key: 'hub' })
})

test('no hub and no worker → drop', () => {
  expect(routeTarget({ thread_id: 5, is_private: false }, new Map())).toEqual({ kind: 'drop' })
})
