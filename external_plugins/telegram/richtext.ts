import type { Api } from 'grammy'

export class RichUnsupported extends Error {
  constructor(cause: string) { super(`RichUnsupported: ${cause}`) }
}

let richSupported = true
export function isRichSupported(): boolean { return richSupported }
export function resetRichCapability(): void { richSupported = true }

type RawRich = { sendRichMessage: (p: unknown) => Promise<{ message_id: number }> }

function looksUnsupported(err: any): boolean {
  const code = err?.error_code
  const desc = String(err?.description ?? err?.message ?? '')
  return code === 404 || /not found|unsupported|unknown method|BOT_METHOD_INVALID/i.test(desc)
}

export type SendRichParams = {
  chat_id: string
  text: string
  message_thread_id?: number
  reply_to?: number
}

/** Send a Rich Message (Markdown-native). Throws RichUnsupported to trigger fallback. */
export async function sendRich(api: Api, p: SendRichParams): Promise<number> {
  const raw = (api as any).raw as RawRich
  try {
    const res = await raw.sendRichMessage({
      chat_id: p.chat_id,
      ...(p.message_thread_id != null ? { message_thread_id: p.message_thread_id } : {}),
      rich_message: { markdown: p.text },
      ...(p.reply_to != null ? { reply_parameters: { message_id: p.reply_to } } : {}),
    })
    richSupported = true
    return res.message_id
  } catch (err) {
    if (looksUnsupported(err)) { richSupported = false; throw new RichUnsupported(String((err as any)?.description ?? err)) }
    throw err
  }
}

export async function editRich(api: Api, chat_id: string, message_id: number, text: string): Promise<number> {
  const raw = (api as any).raw as { editMessageText: (p: unknown) => Promise<any> }
  try {
    const res = await raw.editMessageText({ chat_id, message_id, rich_message: { markdown: text } })
    richSupported = true
    return typeof res === 'object' ? res.message_id : message_id
  } catch (err) {
    if (looksUnsupported(err)) { richSupported = false; throw new RichUnsupported(String((err as any)?.description ?? err)) }
    throw err
  }
}
