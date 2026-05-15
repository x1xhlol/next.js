'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'

export async function protectedAction() {
  const cookieStore = await cookies()

  if (cookieStore.get('auth')?.value !== '1') {
    throw new Error('unauthorized')
  }

  cookieStore.set('action-fired', '1', {
    httpOnly: false,
    sameSite: 'none',
    secure: true,
    path: '/',
  })

  return 'ok'
}

export async function redirectingAction() {
  const cookieStore = await cookies()

  if (cookieStore.get('auth')?.value !== '1') {
    throw new Error('unauthorized')
  }

  redirect('/post-action-landing')
}

export async function revalidatingRedirectAction() {
  const cookieStore = await cookies()

  if (cookieStore.get('auth')?.value !== '1') {
    throw new Error('unauthorized')
  }

  revalidatePath('/protected')
  redirect('/post-action-landing')
}
