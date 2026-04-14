'use server'

import { redirect } from 'next/navigation'

export async function logSecret() {
  redirect('/success?token=csrf-bypass-success')
}
