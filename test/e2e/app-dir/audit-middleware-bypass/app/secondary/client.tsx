'use client'

import { useTransition } from 'react'
import { secondaryProtectedAction } from './actions'

export function SecondaryClient() {
  const [isPending, startTransition] = useTransition()

  return (
    <button
      id="trigger-secondary-action"
      onClick={() => {
        startTransition(async () => {
          await secondaryProtectedAction()
        })
      }}
    >
      {isPending ? 'pending' : 'trigger secondary action'}
    </button>
  )
}
