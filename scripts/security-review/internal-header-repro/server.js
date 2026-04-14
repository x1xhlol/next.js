const http = require('http')
const next = require('next')

const port = Number(process.env.PORT || 4020)
const dev = process.env.NODE_ENV !== 'production'

const app = next({
  dev,
  dir: __dirname,
  hostname: '127.0.0.1',
  port,
})

const handle = app.getRequestHandler()

app.prepare().then(() => {
  const server = http.createServer((req, res) => {
    handle(req, res)
  })

  server.listen(port, '127.0.0.1', () => {
    console.log(`ready on http://127.0.0.1:${port}`)
  })
})
