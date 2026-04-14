import Form from '../form'

export const runtime = 'edge'

async function action(payload = '') {
  'use server'
  console.log('size =', payload.length)
}

export default function Page() {
  return <Form action={action} />
}
