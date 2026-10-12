import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { exchangeGoogleCode, fetchGoogleProfile, requestOrigin } from '@/lib/google'
import { getSession, setSession } from '@/lib/session'

export const OAUTH_STATE_COOKIE = 'fleetwise_oauth_state'

export type OauthState = { state: string; origin: string }

export async function completeOauthLogin(code: string, state: string) {
  const existing = await getSession()
  if (existing) redirect('/')
  const jar = await cookies()
  let expected: OauthState | null = null
  try {
    expected = JSON.parse(jar.get(OAUTH_STATE_COOKIE)?.value || 'null') as OauthState | null
  } catch {
    expected = null
  }
  if (!code || !state || !expected?.state || state !== expected.state) {
    redirect('/sign-in?error=Sign-in expired. Click Continue with Google again.')
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
  } catch (err) {
    redirect(`/sign-in?error=${encodeURIComponent(err instanceof Error ? err.message : 'Google sign-in failed.')}`)
  }
  redirect('/')
}
