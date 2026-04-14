'use server'

async function hiddenHelper() {
  return 'TOP_SECRET_MARKER'
}

export async function leakAction() {
  await hiddenHelper()
  return 'ok'
}

export async function leakCandidate() {
  return 'server secret placeholder'
}
