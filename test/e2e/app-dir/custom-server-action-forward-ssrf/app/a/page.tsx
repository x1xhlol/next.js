export default function PageA() {
  async function action() {
    'use server'
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
