import { getSecretLabel } from './secret'

export default function Page() {
  const secretLength = getSecretLabel().length

  return <p data-secret-length={secretLength}>hello world</p>
}
