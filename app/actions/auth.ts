'use server'

import { randomBytes } from 'crypto'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { googleAuthUrl, requestOrigin } from '@/lib/google'
import { completeOauthLogin, OAUTH_STATE_COOKIE, type OauthState } from '@/lib/oauth'
import { clearSession, getSession } from '@/lib/session'

export async function getCurrentUser() {
  const session = await getSession()
  if (!session) return null
  return { name: session.name, email: session.email, image: session.image }
}

export async function startGoogleSignIn() {
  let url = ''
  try {
    const origin = await requestOrigin()
    const state = randomBytes(16).toString('hex')
    const jar = await cookies()
    const payload: OauthState = { state, origin }
    jar.set(OAUTH_STATE_COOKIE, JSON.stringify(payload), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 600,
    })
    url = googleAuthUrl(origin, state)
  } catch (err) {
    redirect(`/sign-in?error=${encodeURIComponent(err instanceof Error ? err.message : 'oauth')}`)
  }
  redirect(url)
}

export async function completeGoogleSignIn(formData: FormData) {
  const session = await getSession()
  if (session) redirect('/')
  await completeOauthLogin(String(formData.get('code') || ''), String(formData.get('state') || ''))
}

export async function signOutUser() {
  await clearSession()
  redirect('/sign-in')
}
