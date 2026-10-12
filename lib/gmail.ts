import { getGoogleAccessToken } from '@/lib/google'

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'

async function gmailFetch(path: string) {
  const { token } = await getGoogleAccessToken()
  const res = await fetch(`${GMAIL}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `Gmail request failed (${res.status})`)
  }
  return res.json()
}

export type GmailMessage = {
  id: string
  threadId: string
  internalDate?: string
  snippet?: string
  payload?: {
    mimeType?: string
    filename?: string
    headers?: { name: string; value: string }[]
    body?: { data?: string; attachmentId?: string; size?: number }
    parts?: GmailMessage['payload'][]
  }
}

export async function listRecentMessages(query = 'has:attachment newer_than:21d') {
  const data = await gmailFetch(`/messages?maxResults=40&q=${encodeURIComponent(query)}`) as { messages?: { id: string }[] }
  return data.messages || []
}

export async function getMessage(id: string) {
  return gmailFetch(`/messages/${id}?format=full`) as Promise<GmailMessage>
}

export async function getAttachment(messageId: string, attachmentId: string) {
  const data = await gmailFetch(`/messages/${messageId}/attachments/${attachmentId}`) as { data?: string }
  if (!data.data) return Buffer.alloc(0)
  return Buffer.from(data.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

function header(message: GmailMessage, name: string) {
  return message.payload?.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value || ''
}

export function messageMeta(message: GmailMessage) {
  return {
    subject: header(message, 'Subject'),
    from: header(message, 'From'),
    date: header(message, 'Date'),
    snippet: message.snippet || '',
  }
}

export function findAttachments(payload: GmailMessage['payload'] | undefined): { filename: string; mimeType: string; attachmentId: string }[] {
  if (!payload) return []
  const found: { filename: string; mimeType: string; attachmentId: string }[] = []
  const walk = (part: GmailMessage['payload'] | undefined) => {
    if (!part) return
    if (part.filename && part.body?.attachmentId) {
      found.push({ filename: part.filename, mimeType: part.mimeType || 'application/octet-stream', attachmentId: part.body.attachmentId })
    }
    part.parts?.forEach(walk)
  }
  walk(payload)
  return found
}
