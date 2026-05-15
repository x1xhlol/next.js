import Link from 'next/link'
import { Client } from './client'

export default function Page() {
  return (
    <main>
      <p id="status">server action audit harness</p>
      <Link href="/interception/photo" id="direct-photo-link">
        direct photo link
      </Link>
      <Client />
    </main>
  )
}
