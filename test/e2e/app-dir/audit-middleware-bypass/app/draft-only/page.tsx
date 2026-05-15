import { draftMode } from 'next/headers'

export default async function DraftOnlyPage() {
  const { isEnabled } = await draftMode()

  return (
    <main>
      <p id="draft-mode-status">
        {isEnabled ? 'DRAFT SECRET PAYLOAD' : 'draft mode disabled'}
      </p>
    </main>
  )
}
