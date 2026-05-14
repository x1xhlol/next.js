import { nextTestSetup } from 'e2e-utils'
import { retry } from 'next-test-utils'

describe('devtools-unauthenticated-endpoints', () => {
  const { next } = nextTestSetup({
    files: __dirname,
  })

  async function callMcpTool(name: string, options: { origin?: string } = {}) {
    const response = await fetch(`${next.url}/_next/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(options.origin ? { origin: options.origin } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `call-${name}`,
        method: 'tools/call',
        params: {
          name,
          arguments: {},
        },
      }),
    })

    return {
      status: response.status,
      text: await response.text(),
    }
  }

  async function requestOriginalStackFrames(options: { origin?: string } = {}) {
    const response = await fetch(`${next.url}/__nextjs_original-stack-frames`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(options.origin ? { origin: options.origin } : {}),
      },
      body: JSON.stringify({
        frames: [
          {
            file: `file://${next.testDir}/app/secret.ts`,
            line1: 1,
            column1: 1,
            methodName: 'getSecretLabel',
          },
        ],
        isServer: true,
        isEdgeServer: false,
        isAppDirectory: true,
      }),
    })

    return {
      status: response.status,
      text: await response.text(),
    }
  }

  it('allows unauthenticated no-origin MCP access to project metadata', async () => {
    const noOriginResponse = await callMcpTool('get_project_metadata')
    expect(noOriginResponse.status).toBe(200)

    const match = noOriginResponse.text.match(/data: ({.*})/s)
    expect(match).toBeTruthy()

    const payload = JSON.parse(match![1])
    const metadata = JSON.parse(payload.result.content[0].text)

    expect(metadata).toMatchObject({
      projectPath: next.testDir,
      devServerUrl: next.url,
    })

    const evilOriginResponse = await callMcpTool('get_project_metadata', {
      origin: 'https://example.vercel.sh',
    })
    expect(evilOriginResponse).toMatchObject({
      status: 403,
      text: 'Unauthorized',
    })
  })

  it('lets unauthenticated callers enumerate routes via MCP', async () => {
    const noOriginResponse = await callMcpTool('get_routes')
    expect(noOriginResponse.status).toBe(200)

    const match = noOriginResponse.text.match(/data: ({.*})/s)
    expect(match).toBeTruthy()

    const payload = JSON.parse(match![1])
    const routes = JSON.parse(payload.result.content[0].text)
    expect(routes).toEqual({
      appRouter: ['/'],
    })
  })

  it('returns stack-frame path data without an origin header', async () => {
    const noOriginResponse = await requestOriginalStackFrames()
    expect(noOriginResponse.status).toBe(200)

    expect(JSON.parse(noOriginResponse.text)).toEqual([
      {
        status: 'fulfilled',
        value: {
          originalStackFrame: {
            arguments: [],
            file: 'app/secret.ts',
            line1: 1,
            column1: 1,
            ignored: false,
            methodName: 'getSecretLabel',
          },
          originalCodeFrame: null,
        },
      },
    ])

    const evilOriginResponse = await requestOriginalStackFrames({
      origin: 'https://example.vercel.sh',
    })
    expect(evilOriginResponse).toMatchObject({
      status: 403,
      text: 'Unauthorized',
    })
  })

  it('exposes the workspace root through the chrome devtools manifest', async () => {
    const noOriginResponse = await fetch(
      `${next.url}/.well-known/appspecific/com.chrome.devtools.json`
    )
    expect(noOriginResponse.status).toBe(200)

    const noOriginManifest = await noOriginResponse.json()
    expect(noOriginManifest).toEqual({
      workspace: {
        uuid: expect.any(String),
        root: next.testDir,
      },
    })

    const explicitOriginResponse = await fetch(
      `${next.url}/.well-known/appspecific/com.chrome.devtools.json`,
      {
        headers: {
          origin: 'https://example.vercel.sh',
        },
      }
    )
    expect(explicitOriginResponse.status).toBe(200)
    expect(await explicitOriginResponse.json()).toEqual({
      workspace: {
        uuid: expect.any(String),
        root: next.testDir,
      },
    })
  })

  it('exposes a stable server execution identifier without an origin header', async () => {
    const noOriginFirst = await fetch(`${next.url}/__nextjs_server_status`)
    const noOriginSecond = await fetch(`${next.url}/__nextjs_server_status`)

    expect(noOriginFirst.status).toBe(200)
    expect(noOriginSecond.status).toBe(200)

    const firstPayload = await noOriginFirst.json()
    const secondPayload = await noOriginSecond.json()

    expect(firstPayload).toEqual({
      executionId: expect.any(Number),
    })
    expect(secondPayload).toEqual(firstPayload)

    const evilOriginResponse = await fetch(
      `${next.url}/__nextjs_server_status`,
      {
        headers: {
          origin: 'https://example.vercel.sh',
        },
      }
    )
    expect(evilOriginResponse).toMatchObject({
      status: 403,
      statusText: 'Forbidden',
    })
    expect(await evilOriginResponse.text()).toBe('Unauthorized')
  })

  it('lets unauthenticated callers restart the dev server process', async () => {
    const before = await fetch(`${next.url}/__nextjs_server_status`).then(
      (res) => res.json()
    )

    const restartResponse = await fetch(`${next.url}/__nextjs_restart_dev`, {
      method: 'POST',
    })
    expect(restartResponse.status).toBe(204)

    await retry(async () => {
      const after = await fetch(`${next.url}/__nextjs_server_status`).then(
        (res) => res.json()
      )
      expect(after).toEqual({
        executionId: expect.any(Number),
      })
      expect(after.executionId).not.toBe(before.executionId)
    })

    const evilOriginResponse = await fetch(`${next.url}/__nextjs_restart_dev`, {
      method: 'POST',
      headers: {
        origin: 'https://example.vercel.sh',
      },
    })
    expect(evilOriginResponse).toMatchObject({
      status: 403,
      statusText: 'Forbidden',
    })
    expect(await evilOriginResponse.text()).toBe('Unauthorized')
  })
})
