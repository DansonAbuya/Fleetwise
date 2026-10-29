import { completeOauthLogin } from '@/lib/oauth'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const error = request.nextUrl.searchParams.get('error')
  const code = request.nextUrl.searchParams.get('code')
  const state = request.nextUrl.searchParams.get('state')
  if (error === 'access_denied') {
    return NextResponse.redirect(new URL('/sign-in?error=Google sign-in was cancelled.', request.url))
  }
  if (error || !code || !state) {
    return NextResponse.redirect(new URL('/sign-in?error=Google did not return a sign-in code. Try again.', request.url))
  }
  const nextPath = await completeOauthLogin(code, state)
  return NextResponse.redirect(new URL(nextPath, request.url))
}
