'use client'

import { useTransition } from 'react'
import {
  protectedAction,
  redirectingAction,
  revalidatingRedirectAction,
} from './actions'

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
      <button
        id="trigger-revalidating-redirect-action"
        onClick={() => {
          startTransition(async () => {
            await revalidatingRedirectAction()
          })
        }}
      >
        revalidating redirect action
      </button>
    </>
  )
}
