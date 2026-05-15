import { NextResponse } from 'next/server'

export async function GET() {
  const response = NextResponse.json({ ok: true })

  response.cookies.set('auth', '1', {
    httpOnly: false,
    sameSite: 'none',
    secure: true,
    path: '/',
  })

  response.cookies.delete('action-fired')

  return response
}
