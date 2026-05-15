import { NextResponse } from 'next/server'

export async function GET() {
  process.env.__NEXT_PRIVATE_ORIGIN = ''

  return NextResponse.json({ success: true })
}
