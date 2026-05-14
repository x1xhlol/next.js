export default function PageB() {
  async function action() {
    'use server'
  }

  return (
    <main>
      <p id="page-id">page-b</p>
      <form action={action}>
        <button type="submit">Run action B</button>
      </form>
    </main>
  )
}
