const fs = require('fs')
const https = require('https')
const { join } = require('path')

const {
  apiResolver,
} = require('../../../../packages/next/dist/server/api-utils/node/api-resolver.js')
const {
  MockedRequest,
  MockedResponse,
} = require('../../../../packages/next/dist/server/lib/mock-request.js')

async function main() {
  let captured
  const previewModeId = process.env.AUDIT_PREVIEW_MODE_ID || 'preview-token'

  const httpsServer = https.createServer(
    {
      key: fs.readFileSync(
        join(__dirname, '../next-image/certificates/localhost-key.pem'),
        'utf8'
      ),
      cert: fs.readFileSync(
        join(__dirname, '../next-image/certificates/localhost.pem'),
        'utf8'
      ),
    },
    (req, res) => {
      captured = {
        method: req.method,
        url: req.url,
        headers: req.headers,
      }
      res.writeHead(200, { 'x-nextjs-cache': 'REVALIDATED' })
      res.end('ok')
    }
  )

  await new Promise((resolve) => {
    httpsServer.listen(0, '127.0.0.1', () => resolve())
  })

  try {
    const { port } = httpsServer.address()
    const req = new MockedRequest({
      url: '/api/revalidate',
      headers: {
        host: `localhost:${port}`,
        cookie: 'session=stealme',
      },
      method: 'GET',
    })
    const res = new MockedResponse()

    await apiResolver(
      req,
      res,
      {},
      async (_req, apiRes) => {
        await apiRes.revalidate('/')
        apiRes.status(200).json({ ok: true })
      },
      {
        previewModeId,
        previewModeEncryptionKey: '0123456789abcdef0123456789abcdef',
        previewModeSigningKey: '0123456789abcdef0123456789abcdef',
        trustHostHeader: true,
        dev: false,
      },
      false,
      false,
      '/api/revalidate',
      undefined
    )
    await res.hasStreamed

    process.stdout.write(
      JSON.stringify(
        {
          statusCode: res.statusCode,
          body: Buffer.concat(res.buffers).toString('utf8'),
          captured,
        },
        null,
        2
      )
    )
  } finally {
    await new Promise((resolve, reject) => {
      httpsServer.close((err) => {
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      })
    })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
