process.env.NODE_ENV = 'production'
process.env.__NEXT_PRIVATE_PREBUNDLED_REACT = 'next'

const http = require('http')
const path = require('path')

const appDir = __dirname
process.chdir(appDir)

const NextServer =
  require('/workspace/packages/next/dist/server/next-server').default

const distDir = '.next'
const compiledConfig = require(
  path.join(appDir, distDir, 'required-server-files.json')
).config

const nextServer = new NextServer({
  conf: compiledConfig,
  dir: '.',
  distDir,
  minimalMode: true,
  customServer: false,
})

const requestHandler = nextServer.getRequestHandler()
const port = Number(process.env.PORT || 4022)

http
  .createServer((req, res) => {
    return requestHandler(req, res).catch((err) => {
      console.error(err)
      res.statusCode = 500
      res.end('Internal Server Error')
    })
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`minimal server ready on http://127.0.0.1:${port}`)
  })
