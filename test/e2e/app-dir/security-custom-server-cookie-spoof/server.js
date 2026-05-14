const http = require('http')
const next = require('next')

async function main() {
  const dev = process.env.NEXT_TEST_MODE === 'dev'
  process.env.NODE_ENV = dev ? 'development' : 'production'

  const port = Number(process.env.PORT || 37100)

  const app = next({ dev, port })
  const handle = app.getRequestHandler()

  await app.prepare()

  const server = http.createServer(async (req, res) => {
    try {
      await handle(req, res)
    } catch (err) {
      console.error(err)
      res.statusCode = 500
      res.end('Internal Server Error')
    }
  })

  server.once('error', (err) => {
    console.error(err)
    process.exit(1)
  })

  server.listen(port, () => {
    console.log(`- Local: http://localhost:${port}`)
    console.log(`- Next mode: ${dev ? 'development' : process.env.NODE_ENV}`)
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
