import { NextResponse } from 'next/server'
import { abandonProcessing } from '@/modules/stock/actions'

export async function GET(request: Request) {
  await abandonProcessing().catch(() => {})
  const response = NextResponse.redirect(new URL('/sign-in', request.url))
  const expired = { path: '/', maxAge: 0 }
  response.cookies.set('fleetwise_session', '', expired)
  response.cookies.set('fleetwise_tokens', '', expired)
  return response
}
