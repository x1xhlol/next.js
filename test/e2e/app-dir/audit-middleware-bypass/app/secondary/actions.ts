'use server'

import { cookies } from 'next/headers'

export async function secondaryProtectedAction() {
  const cookieStore = await cookies()

  if (cookieStore.get('auth')?.value !== '1') {
    throw new Error('unauthorized')
  }

  return 'secondary ok'
}
