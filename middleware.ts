import { NextRequest, NextResponse } from 'next/server'

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (pathname.startsWith('/auth') || pathname.startsWith('/sign-in') || pathname.startsWith('/_next') || pathname.includes('.')) {
    return NextResponse.next()
  }
  const session = request.cookies.get('fleetwise_session')?.value
  if (!session && pathname === '/') {
    return NextResponse.redirect(new URL('/sign-in', request.url))
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
