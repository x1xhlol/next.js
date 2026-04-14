const next = require('next')
const http = require('http')

const port = Number(process.env.PORT || 4026)
const dev = false

const app = next({
  dev,
  dir: __dirname,
  hostname: '127.0.0.1',
  port,
})

const handle = app.getRequestHandler()

app.prepare().then(() => {
  http
    .createServer((req, res) => {
      handle(req, res)
    })
    .listen(port, '127.0.0.1', () => {
      console.log(`custom revalidate server ready on http://127.0.0.1:${port}`)
    })
})
