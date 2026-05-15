import { NextResponse } from 'next/server'

export function proxy(request: Request) {
  const url = new URL(request.url)
  const authCookie =
    request.headers
      .get('cookie')
      ?.split(';')
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie === 'auth=1') ?? null

  if (url.pathname.startsWith('/protected') && !authCookie) {
    return new NextResponse('blocked by middleware', { status: 401 })
  }

  return NextResponse.next()
}
