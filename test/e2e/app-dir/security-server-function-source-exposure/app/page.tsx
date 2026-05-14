async function stringifyValue(value: unknown) {
  'use server'

  return String(value)
}

export default function Page() {
  return (
    <main>
      <p id="status">ready</p>
      <form action={stringifyValue}>
        <button type="submit" id="submit">
          Submit
        </button>
      </form>
    </main>
  )
}
