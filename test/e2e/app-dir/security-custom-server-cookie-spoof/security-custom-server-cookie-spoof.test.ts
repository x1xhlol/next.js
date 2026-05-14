import { nextTestSetup } from 'e2e-utils'

describe('security-custom-server-cookie-spoof', () => {
  const { next } = nextTestSetup({
    files: __dirname,
  })

  it('renders the unauthenticated state', async () => {
    const $ = await next.render$('/')
    expect($('#auth').text()).toBe('auth=none')
    expect($('#access').text()).toBe('public page')
  })
})
