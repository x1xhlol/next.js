import { redirect } from 'next/navigation'

export default function PageA() {
  async function action() {
    'use server'
    redirect('/redirect-target')
  }

  return (
    <main>
      <p id="page-id">page-a</p>
      <form action={action}>
        <button type="submit">Run action A</button>
      </form>
    </main>
  )
}
