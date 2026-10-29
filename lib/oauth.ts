import { cookies } from 'next/headers'
import { exchangeGoogleCode, fetchGoogleProfile, requestOrigin } from '@/lib/google'
import { getSession, setSession } from '@/lib/session'

export const OAUTH_STATE_COOKIE = 'fleetwise_oauth_state'

export type OauthState = { state: string; origin: string }

export async function completeOauthLogin(code: string, state: string) {
  const existing = await getSession()
  if (existing) return '/'
  const jar = await cookies()
  let expected: OauthState | null = null
  try {
    expected = JSON.parse(jar.get(OAUTH_STATE_COOKIE)?.value || 'null') as OauthState | null
  } catch {
    expected = null
  }
  if (!code || !state || !expected?.state || state !== expected.state) {
    return '/sign-in?error=Sign-in expired. Click Continue with Google again.'
  }
  try {
    const origin = expected.origin || await requestOrigin()
    const tokens = await exchangeGoogleCode(origin, code)
    const profile = await fetchGoogleProfile(tokens.access_token)
    await setSession({
      sub: profile.sub,
      email: profile.email,
      name: profile.name || profile.email,
      image: profile.picture,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || '',
      expiresAt: Math.floor(Date.now() / 1000) + (tokens.expires_in || 3600) - 60,
    })
    jar.delete(OAUTH_STATE_COOKIE)
    return '/'
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Google sign-in failed.'
    const readable = /fetch failed|empty response|unreadable response|network/i.test(message)
      ? 'Could not reach Google. Check the network and click Continue with Google again.'
      : message
    return `/sign-in?error=${encodeURIComponent(readable)}`
  }
}
