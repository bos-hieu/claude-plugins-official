import { expect, test } from 'bun:test'
import { chunk } from './chunk'

test('short text returns single chunk', () => {
  expect(chunk('hello', 4096, 'length')).toEqual(['hello'])
})

test('length mode hard-cuts at limit', () => {
  const parts = chunk('a'.repeat(10), 4, 'length')
  expect(parts.every(p => p.length <= 4)).toBe(true)
  expect(parts.join('')).toBe('a'.repeat(10))
})

test('newline mode prefers paragraph boundary', () => {
  const text = 'para one here\n\npara two here'
  const parts = chunk(text, 16, 'newline')
  expect(parts[0]).toBe('para one here')
})
