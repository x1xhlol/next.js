import { leakableAction } from './action'

export default function Page() {
  return (
    <main>
      <h1>source disclosure repro</h1>
      <form action={leakableAction}>
        <button id="submit" type="submit">
          submit
        </button>
      </form>
    </main>
  )
}
