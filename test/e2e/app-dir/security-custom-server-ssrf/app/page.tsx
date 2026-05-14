import { cookies } from 'next/headers'

export default async function Page() {
  const auth = (await cookies()).get('auth')?.value ?? 'none'
  const access = auth === 'admin' ? 'secret admin panel' : 'public page'

  return (
    <main>
      <p id="auth">auth={auth}</p>
      <p id="access">{access}</p>
    </main>
  )
}
