'use client'

import { useTransition } from 'react'
import { protectedAction, redirectingAction } from './actions'

export function Client() {
  const [isPending, startTransition] = useTransition()

  return (
    <>
      <button
        id="trigger-action"
        onClick={() => {
          startTransition(async () => {
            await protectedAction()
          })
        }}
      >
        {isPending ? 'pending' : 'trigger action'}
      </button>
      <button
        id="trigger-redirect-action"
        onClick={() => {
          startTransition(async () => {
            await redirectingAction()
          })
        }}
      >
        redirect action
      </button>
    </>
  )
}
