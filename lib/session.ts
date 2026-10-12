import { createHmac } from 'crypto'
import { cookies } from 'next/headers'

export type AppSession = {
  sub: string
  email: string
  name: string
  image?: string
  accessToken: string
  refreshToken: string
  expiresAt: number
}

const COOKIE = 'fleetwise_session'
const TOKEN_COOKIE = 'fleetwise_tokens'

function secret() {
  return process.env.AUTH_SECRET ?? process.env.BETTER_AUTH_SECRET ?? 'v0-preview-secret-replace-in-production-32chars'
}

function encodeValue(payload: object) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', secret()).update(body).digest('base64url')
  return `${body}.${sig}`
}

function decodeValue<T>(token: string | undefined): T | null {
  if (!token) return null
  const split = token.lastIndexOf('.')
  if (split <= 0) return null
  const body = token.slice(0, split)
  const sig = token.slice(split + 1)
  const expected = createHmac('sha256', secret()).update(body).digest('base64url')
  if (expected.length !== sig.length) return null
  let mismatch = 0
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ sig.charCodeAt(i)
  if (mismatch !== 0) return null
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T
  } catch {
    return null
  }
}

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: 60 * 60 * 24 * 7,
}

export async function getSession() {
  const jar = await cookies()
  const profile = decodeValue<Omit<AppSession, 'accessToken' | 'refreshToken'>>(jar.get(COOKIE)?.value)
  const tokens = decodeValue<Pick<AppSession, 'accessToken' | 'refreshToken' | 'expiresAt'>>(jar.get(TOKEN_COOKIE)?.value)
  if (profile && tokens?.accessToken) {
    return { ...profile, ...tokens, expiresAt: tokens.expiresAt || profile.expiresAt }
  }
  const legacy = decodeValue<AppSession>(jar.get(COOKIE)?.value)
  if (legacy?.accessToken) return legacy
  return null
}

export async function setSession(payload: AppSession) {
  const jar = await cookies()
  const { accessToken, refreshToken, expiresAt, ...profile } = payload
  jar.set(COOKIE, encodeValue({ ...profile, expiresAt }), cookieOptions)
  jar.set(TOKEN_COOKIE, encodeValue({ accessToken, refreshToken, expiresAt }), cookieOptions)
}

export async function clearSession() {
  const jar = await cookies()
  jar.delete(COOKIE)
  jar.delete(TOKEN_COOKIE)
}

export async function requireSession() {
  const session = await getSession()
  if (!session) throw new Error('Unauthorized')
  return session
}
