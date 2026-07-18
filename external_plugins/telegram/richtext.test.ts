import { expect, test } from 'bun:test'
import { sendRich, resetRichCapability, isRichSupported } from './richtext'

function mockApi(behavior: 'ok' | 'unsupported') {
  return {
    raw: {
      sendRichMessage: async (_p: any) => {
        if (behavior === 'unsupported') { const e: any = new Error('Method not found'); e.error_code = 404; throw e }
        return { message_id: 7 }
      },
    },
  } as any
}

test('sendRich returns message id when supported', async () => {
  resetRichCapability()
  const id = await sendRich(mockApi('ok'), { chat_id: '1', text: '# hi', message_thread_id: 34 })
  expect(id).toBe(7)
  expect(isRichSupported()).toBe(true)
})

test('sendRich throws RichUnsupported and flips capability off', async () => {
  resetRichCapability()
  await expect(sendRich(mockApi('unsupported'), { chat_id: '1', text: 'x' })).rejects.toThrow('RichUnsupported')
  expect(isRichSupported()).toBe(false)
})
