import { logSecret } from './action'

export default function Page() {
  return (
    <main>
      <h1>csrf repro</h1>
      <form action={logSecret}>
        <button id="trigger" type="submit">
          trigger
        </button>
      </form>
    </main>
  )
}
