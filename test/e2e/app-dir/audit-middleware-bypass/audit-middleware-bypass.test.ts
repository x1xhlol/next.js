import fs from 'fs'
import fsPromises from 'node:fs/promises'
import http from 'http'
import type { AddressInfo } from 'net'
import net from 'net'
import { nextTestSetup } from 'e2e-utils'
import { join } from 'node:path'
import { listClientChunks, retry } from 'next-test-utils'

type CapturedActionRequest = {
  headers: Record<string, string>
  postData: string
}

describe('audit-middleware-bypass', () => {
  const auditSecret = `audit-secret-${Date.now()}`
  const { next, isNextStart } = nextTestSetup({
    files: __dirname,
    env: {
      AUDIT_SECRET: auditSecret,
    },
  })

  let evilServer: http.Server
  let evilOrigin: string
  let evilRequests: string[]
  let evilUpgradeRequests: string[]

  beforeAll(async () => {
    const evilHostname =
      new URL(next.url).hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1'
    evilRequests = []
    evilUpgradeRequests = []

    evilServer = http.createServer((req, res) => {
      const requestUrl = new URL(req.url || '/', 'http://n')

      evilRequests.push(requestUrl.pathname)

      if (requestUrl.pathname !== '/attack') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('evil server')
        return
      }

      const payload = requestUrl.searchParams.get('payload')
      if (!payload) {
        res.writeHead(500)
        res.end('missing payload')
        return
      }

      const {
        targetUrl,
        actionId,
        contentType,
        body,
        accept,
        nextUrl,
        routerStateTree,
      } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        targetUrl: string
        actionId: string
        contentType?: string
        body: string
        accept?: string
        nextUrl?: string
        routerStateTree?: string
      }

      const headers: Record<string, string> = {
        'next-action': actionId,
        'x-forwarded-host': `${evilHostname}:${(evilServer.address() as AddressInfo).port}`,
      }

      if (contentType) headers['content-type'] = contentType
      if (accept) headers.accept = accept
      if (nextUrl) headers['next-url'] = nextUrl
      if (routerStateTree) {
        headers['next-router-state-tree'] = routerStateTree
      }

      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(`<!doctype html>
<html>
  <body>
    <div id="result">pending</div>
    <script>
      (async function () {
        const resultEl = document.getElementById('result')
        try {
          const response = await fetch(${JSON.stringify(targetUrl)}, {
            method: 'POST',
            credentials: 'include',
            headers: ${JSON.stringify(headers)},
            body: ${JSON.stringify(body)},
          })
          resultEl.textContent = 'status:' + response.status
        } catch (error) {
          resultEl.textContent = 'error:' + error.message
        }
      })()
    </script>
  </body>
</html>`)
    })

    evilServer.on('upgrade', (req, socket) => {
      evilUpgradeRequests.push(req.url || '')
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Connection: Upgrade\r\n' +
          'Upgrade: websocket\r\n' +
          '\r\n'
      )
      socket.end()
    })

    await new Promise<void>((resolve) => {
      evilServer.listen(0, '127.0.0.1', () => resolve())
    })

    evilOrigin = `http://${evilHostname}:${(evilServer.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      evilServer.close((err) => {
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      })
    })
  })

  it.each([
    {
      name: 'plain protected route',
      path: '/protected',
      headers: undefined,
    },
    {
      name: 'rsc suffix route',
      path: '/protected.rsc',
      headers: undefined,
    },
    {
      name: 'segment prefetch tree route',
      path: '/protected.segments/_tree.segment.rsc',
      headers: undefined,
    },
    {
      name: 'segment prefetch full route',
      path: '/protected.segments/_full.segment.rsc',
      headers: undefined,
    },
    {
      name: 'header-only rsc request',
      path: '/protected',
      headers: { rsc: '1' },
    },
    {
      name: 'header-only segment prefetch request',
      path: '/protected',
      headers: {
        rsc: '1',
        'next-router-prefetch': '1',
        'next-router-segment-prefetch': '/_tree',
      },
    },
  ])(
    'does not bypass middleware through alternate App Router transport: $name',
    async ({ path, headers }) => {
      const res = await next.fetch(path, { headers })
      const text = await res.text()

      expect(res.status).toBe(401)
      expect(text).toContain('blocked by middleware')
      expect(text).not.toContain('TOP SECRET PAYLOAD')
    }
  )

  it('does not expose a server-only env value in the rendered response', async () => {
    const res = await next.fetch('/server-only')
    const text = await res.text()

    expect(res.status).toBe(200)
    expect(text).not.toContain(auditSecret)
    expect(text).toContain('server-only page')
  })

  if (isNextStart) {
    it('does not include a server-only env value in client chunks or sourcemaps', async () => {
      const clientChunks = await listClientChunks(
        join(next.testDir, next.distDir)
      )
      const chunkContents = await Promise.all(
        clientChunks
          .filter((file) => file.endsWith('.js') || file.endsWith('.js.map'))
          .map((file) =>
            fsPromises.readFile(join(next.testDir, next.distDir, file), 'utf8')
          )
      )

      expect(chunkContents.length).toBeGreaterThan(0)
      for (const content of chunkContents) {
        expect(content).not.toContain(auditSecret)
      }
    })

    it('does not proxy absolute-form websocket upgrade requests to attacker targets', async () => {
      evilUpgradeRequests.length = 0

      const nextUrl = new URL(next.url)
      const evilPort = (evilServer.address() as AddressInfo).port

      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection(
          {
            host: nextUrl.hostname,
            port: Number(nextUrl.port),
          },
          () => {
            socket.write(
              [
                `GET http://127.0.0.1:${evilPort}/ws-attack HTTP/1.1`,
                'Host: victim.example',
                'Connection: Upgrade',
                'Upgrade: websocket',
                'Sec-WebSocket-Version: 13',
                'Sec-WebSocket-Key: dGVzdC10ZXN0LXRlc3Q=',
                '',
                '',
              ].join('\r\n')
            )
          }
        )

        socket.once('error', reject)
        socket.once('close', () => resolve())
      })

      expect(evilUpgradeRequests).not.toContain('/ws-attack')
    })
  }

  it('does not allow nxtP query injection to alter a dynamic route param', async () => {
    const res = await next.fetch('/dynamic/public?nxtPslug=admin')
    const text = await res.text()

    expect(res.status).toBe(200)
    expect(text).toContain('dynamic public payload:')
    expect(text).toContain('public')
    expect(text).not.toContain('DYNAMIC TOP SECRET PAYLOAD')
  })

  it('still blocks the real protected dynamic pathname', async () => {
    const res = await next.fetch('/dynamic/admin')
    const text = await res.text()

    expect(res.status).toBe(401)
    expect(text).toContain('blocked dynamic admin')
    expect(text).not.toContain('DYNAMIC TOP SECRET PAYLOAD')
  })

  async function captureActionRequest(
    buttonId: 'trigger-action' | 'trigger-redirect-action' = 'trigger-action'
  ): Promise<CapturedActionRequest> {
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

    await browser.eval(`fetch('/api/set-auth', { credentials: 'include' })`)

    await retry(async () => {
      expect(await browser.eval('document.cookie')).toContain('auth=1')
    })

    await browser.elementById(buttonId).click()

    await retry(async () => {
      expect(capturedActionRequest).toBeDefined()
      if (buttonId === 'trigger-action') {
        expect(await browser.eval('document.cookie')).toContain(
          'action-fired=1'
        )
      }
    })

    if (!capturedActionRequest) {
      throw new Error('Expected to capture a valid server action request')
    }

    return capturedActionRequest
  }

  async function issueRequestWithHostHeader({
    hostHeader,
    actionRequest,
  }: {
    hostHeader: string
    actionRequest: CapturedActionRequest
  }) {
    const nextUrl = new URL(next.url)

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
            host: hostHeader,
            origin: `http://${hostHeader}`,
            cookie: 'auth=1',
            'next-action': actionRequest.headers['next-action'],
            'content-type': actionRequest.headers['content-type'],
            accept: actionRequest.headers.accept,
            ...(actionRequest.headers['next-url']
              ? { 'next-url': actionRequest.headers['next-url'] }
              : {}),
            ...(actionRequest.headers['next-router-state-tree']
              ? {
                  'next-router-state-tree':
                    actionRequest.headers['next-router-state-tree'],
                }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = []
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

  it('accepts a forged x-forwarded-host on a raw server action request', async () => {
    const capturedActionRequest = await captureActionRequest()
    const evilHost = new URL(evilOrigin).host

    const res = await next.fetch('/', {
      method: 'POST',
      headers: {
        'next-action': capturedActionRequest.headers['next-action'],
        'content-type': capturedActionRequest.headers['content-type'],
        accept: capturedActionRequest.headers.accept,
        ...(capturedActionRequest.headers['next-url']
          ? { 'next-url': capturedActionRequest.headers['next-url'] }
          : {}),
        ...(capturedActionRequest.headers['next-router-state-tree']
          ? {
              'next-router-state-tree':
                capturedActionRequest.headers['next-router-state-tree'],
            }
          : {}),
        origin: evilOrigin,
        'x-forwarded-host': evilHost,
        cookie: 'auth=1',
      },
      body: capturedActionRequest.postData,
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('action-fired=1')
  })

  it('still fails from a browser-controlled cross-origin page because preflight blocks the custom header', async () => {
    const capturedActionRequest = await captureActionRequest()
    const browser = await next.browser('/')

    await browser.eval(`fetch('/api/set-auth', { credentials: 'include' })`)
    await retry(async () => {
      expect(await browser.eval('document.cookie')).toContain('auth=1')
    })

    const payload = JSON.stringify({
      targetUrl: `${next.url}/`,
      actionId: capturedActionRequest.headers['next-action'],
      contentType: capturedActionRequest.headers['content-type'],
      body: capturedActionRequest.postData,
      accept: capturedActionRequest.headers.accept,
      nextUrl: capturedActionRequest.headers['next-url'],
      routerStateTree: capturedActionRequest.headers['next-router-state-tree'],
    })

    await browser.loadPage(
      `${evilOrigin}/attack?payload=${Buffer.from(payload).toString('base64url')}`
    )

    await retry(async () => {
      expect(await browser.elementById('result').text()).toMatch(/^error:/)
    })

    await browser.loadPage(`${next.url}/`)

    expect(await browser.eval('document.cookie')).toContain('auth=1')
    expect(await browser.eval('document.cookie')).not.toContain(
      'action-fired=1'
    )
  })

  it('does not disclose server action source code to a malformed RSC request', async () => {
    const capturedActionRequest = await captureActionRequest()
    const actionId = capturedActionRequest.headers['next-action']
    const boundary = '----SourceLeak'
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="0"',
      '',
      '["$F1"]',
      `--${boundary}`,
      'Content-Disposition: form-data; name="1"',
      '',
      JSON.stringify({ id: actionId, bound: null }),
      `--${boundary}--`,
      '',
    ].join('\r\n')

    const res = await next.fetch('/', {
      method: 'POST',
      headers: {
        accept: 'text/x-component',
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'next-action': actionId,
      },
      body,
    })

    const text = await res.text()

    expect(text).not.toContain('cookieStore.set')
    expect(text).not.toContain('unauthorized')
    expect(text).not.toContain('action-fired')
  })

  it('does not execute a React2Shell-style multipart payload before action validation', async () => {
    const markerPath = '/tmp/next-audit-react2shell-hit'
    const boundary = '----React2ShellAudit'
    const payload = JSON.stringify({
      then: '$1:__proto__:then',
      status: 'resolved_model',
      reason: -1,
      value: '{"then":"$B0"}',
      _response: {
        _prefix: `process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(markerPath)},'hit');return '';//`,
        _formData: {
          get: '$1:constructor:constructor',
        },
      },
    })
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="0"',
      '',
      payload,
      `--${boundary}`,
      'Content-Disposition: form-data; name="1"',
      '',
      '"$@0"',
      `--${boundary}--`,
      '',
    ].join('\r\n')

    await fs.promises.rm(markerPath, { force: true })

    await next.fetch('/', {
      method: 'POST',
      headers: {
        accept: 'text/x-component',
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'next-action': '123',
      },
      body,
    })

    expect(fs.existsSync(markerPath)).toBe(false)
  })

  it('does not issue server-side redirect fetches to a spoofed Host header', async () => {
    const redirectActionRequest = await captureActionRequest(
      'trigger-redirect-action'
    )
    const evilHost = new URL(evilOrigin).host

    evilRequests.length = 0

    const res = await issueRequestWithHostHeader({
      hostHeader: evilHost,
      actionRequest: redirectActionRequest,
    })

    expect(res.statusCode).toBeGreaterThanOrEqual(300)
    expect(evilRequests).not.toContain('/post-action-landing')
  })
})
