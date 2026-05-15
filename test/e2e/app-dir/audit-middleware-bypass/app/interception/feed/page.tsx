import Link from 'next/link'

export default function FeedPage() {
  return (
    <main>
      <p id="feed-page">feed page</p>
      <Link href="/interception/photo" id="intercepted-photo-link">
        intercepted photo link
      </Link>
    </main>
  )
}
