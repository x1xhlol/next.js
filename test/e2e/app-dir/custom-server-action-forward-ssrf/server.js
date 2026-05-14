// @ts-check

/** @type {import('next').default} */
// @ts-ignore: CommonJS import for the fixture custom server
const next = require('next')
const { createServer } = require('http')
const getPort = require('get-port')

async function main() {
  const dev = process.env.NODE_ENV !== 'production'
  const dir = __dirname
  const hostname = 'localhost'
  const envPort = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 0
  const port = envPort > 0 ? envPort : await getPort()

  const app = next({ dev, dir, hostname, port })
  const handle = app.getRequestHandler()

  await app.prepare()

  createServer((req, res) => handle(req, res)).listen(port, hostname, () => {
    console.log(`- Local: http://${hostname}:${port}`)
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
