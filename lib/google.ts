import { headers } from 'next/headers'
import { getSession, setSession, type AppSession } from '@/lib/session'

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
].join(' ')

function envValue(...keys: string[]) {
  for (const key of keys) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim()) return value.trim().replace(/^["']|["']$/g, '')
  }
}

function googleClient() {
  const clientId = envValue('GOOGLE_CLIENT_ID', 'AUTH_GOOGLE_ID')
  const clientSecret = envValue('GOOGLE_CLIENT_SECRET', 'AUTH_GOOGLE_SECRET')
  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the host (Vercel → Settings → Environment Variables), then redeploy.')
  }
  return { clientId, clientSecret }
}

export function googleRedirectPath() {
  return '/auth/callback/google'
}

export function googleRedirectUri(origin: string) {
  return `${origin}${googleRedirectPath()}`
}

export function googleAuthUrl(origin: string, state: string) {
  const { clientId } = googleClient()
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: googleRedirectUri(origin),
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
    include_granted_scopes: 'true',
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

async function readGoogleJson<T>(res: Response): Promise<T> {
  const text = await res.text()
  if (!text.trim()) throw new Error('Google returned an empty response. Check the network and click Continue with Google again.')
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error('Google returned an unreadable response. Click Continue with Google again.')
  }
}

async function googleTokenRequest(body: URLSearchParams) {
  try {
    return await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
  } catch {
    throw new Error('Could not reach Google. Check the network and click Continue with Google again.')
  }
}

export async function exchangeGoogleCode(origin: string, code: string) {
  const { clientId, clientSecret } = googleClient()
  const res = await googleTokenRequest(new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: googleRedirectUri(origin),
  }))
  const data = await readGoogleJson<{ access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string; error?: string; error_description?: string }>(res)
  if (!res.ok || !data.access_token) {
    const reason = data.error_description || data.error || 'token_exchange_failed'
    if (data.error === 'redirect_uri_mismatch' || /redirect_uri/i.test(reason)) {
      throw new Error(`Google rejected the redirect URI. Add ${googleRedirectUri(origin)} to the OAuth client.`)
    }
    if (data.error === 'invalid_grant') {
      throw new Error('This Google sign-in code was already used. Click Continue with Google again.')
    }
    if (data.error === 'invalid_client') {
      throw new Error('Google OAuth client ID or secret is wrong. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.')
    }
    throw new Error(`Google token exchange failed (${reason}).`)
  }
  return data as { access_token: string; refresh_token?: string; expires_in: number; id_token?: string }
}

export async function fetchGoogleProfile(accessToken: string) {
  let res: Response
  try {
    res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
  } catch {
    throw new Error('Could not reach Google. Check the network and click Continue with Google again.')
  }
  if (!res.ok) throw new Error('Unable to load Google profile')
  return readGoogleJson<{ sub: string; email: string; name?: string; picture?: string }>(res)
}

export async function refreshGoogleToken(session: AppSession): Promise<AppSession> {
  if (!session.refreshToken) throw new Error('Google reconnect required')
  const { clientId, clientSecret } = googleClient()
  const res = await googleTokenRequest(new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: session.refreshToken,
  }))
  const data = await readGoogleJson<{ access_token?: string; expires_in?: number; refresh_token?: string }>(res)
  if (!res.ok || !data.access_token) throw new Error('Google session expired. Sign in again.')
  return {
    ...session,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || session.refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600) - 60,
  }
}

export type GoogleFetchInit = RequestInit & { timeoutMs?: number }

export async function googleFetch(url: string, init: GoogleFetchInit = {}, attempt = 0): Promise<Response> {
  const timeoutMs = init.timeoutMs ?? 60_000
  const { timeoutMs: _timeoutMs, ...rest } = init
  try {
    const res = await fetch(url, {
      ...rest,
      signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
    })
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)))
      return googleFetch(url, init, attempt + 1)
    }
    return res
  } catch (err) {
    const detail = googleErrorDetail(err)
    const retries = timeoutMs > 90_000 ? 1 : 2
    if (attempt < retries && isRetryableGoogleError(detail)) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)))
      return googleFetch(url, init, attempt + 1)
    }
    throw new Error(googleNetworkMessage(detail, timeoutMs))
  }
}

function googleErrorDetail(err: unknown) {
  if (!(err instanceof Error)) return String(err)
  const cause = err.cause instanceof Error
    ? err.cause.message
    : typeof err.cause === 'object' && err.cause && 'code' in err.cause
      ? String((err.cause as { code?: string }).code)
      : ''
  return `${err.name} ${err.message} ${cause}`.trim()
}

function isRetryableGoogleError(detail: string) {
  return /timeout|timed out|aborted|econnreset|und_err|fetch failed|connecttimeout|socket/i.test(detail)
}

export function googleNetworkMessage(detail: string, timeoutMs = 60_000) {
  if (/aborted due to timeout|timeouterror|timed out|und_err_connect_timeout|connecttimeout/i.test(detail)) {
    return `Google Drive took longer than ${Math.round(timeoutMs / 1000)} seconds. The file may be large or the network is slow — try that file again.`
  }
  if (/econnreset|fetch failed|und_err|socket/i.test(detail)) {
    return 'The connection to Google dropped. Check the network and try again.'
  }
  return 'Could not reach Google. Check your network and try again.'
}

export async function getGoogleAccessToken() {
  const session = await getSession()
  if (!session) throw new Error('Unauthorized')
  if (session.expiresAt > Math.floor(Date.now() / 1000) + 30) return { token: session.accessToken, session }
  const next = await refreshGoogleToken(session)
  await setSession(next)
  return { token: next.accessToken, session: next }
}

export function appOrigin(requestUrl?: string) {
  if (process.env.AUTH_URL) return process.env.AUTH_URL.replace(/\/$/, '')
  if (process.env.BETTER_AUTH_URL) return process.env.BETTER_AUTH_URL.replace(/\/$/, '')
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  if (requestUrl) return new URL(requestUrl).origin
  return 'http://localhost:3000'
}

export async function requestOrigin() {
  const headerList = await headers()
  const host = (headerList.get('x-forwarded-host') || headerList.get('host') || '').split(',')[0].trim()
  const proto = (headerList.get('x-forwarded-proto') || '').split(',')[0].trim()
    || (host.includes('localhost') || host.startsWith('127.') ? 'http' : '')
    || (process.env.NODE_ENV === 'production' ? 'https' : 'http')
  if (host) return `${proto}://${host}`.replace(/\/$/, '')
  return appOrigin()
}
