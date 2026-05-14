import { nextTestSetup } from 'e2e-utils'

describe('security-server-function-source-exposure', () => {
  const { next } = nextTestSetup({
    files: __dirname,
  })

  it('renders the source exposure audit fixture', async () => {
    const $ = await next.render$('/')
    expect($('#status').text()).toBe('ready')
  })
})
