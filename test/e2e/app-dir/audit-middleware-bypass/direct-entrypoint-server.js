const { createServer } = require('http')
const fs = require('fs')
const path = require('path')
const { parse } = require('url')

require('next/dist/server/node-environment')

function loadEntrypointHandler(pathParts) {
  const entrypointPath = path.join(__dirname, '.next', 'server', ...pathParts)
  const mod = require(entrypointPath)

  if (typeof mod.handler !== 'function') {
    throw new Error(`Entrypoint handler missing at ${entrypointPath}`)
  }

  return mod.handler
}

const handlers = {
  '/': loadEntrypointHandler(['app', 'page.js']),
  '/draft-only': loadEntrypointHandler(['app', 'draft-only', 'page.js']),
  '/post-action-landing': loadEntrypointHandler([
    'app',
    'post-action-landing',
    'page.js',
  ]),
  '/api/set-auth': loadEntrypointHandler([
    'app',
    'api',
    'set-auth',
    'route.js',
  ]),
}

function sendStaticAsset(res, pathname) {
  const filePath = path.join(
    __dirname,
    '.next',
    pathname.replace(/^\/_next\//, '')
  )

  if (!filePath.startsWith(path.join(__dirname, '.next'))) {
    res.statusCode = 400
    res.end('Bad Request')
    return true
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return false
  }

  const extension = path.extname(filePath)
  const contentType =
    extension === '.js'
      ? 'application/javascript; charset=utf-8'
      : extension === '.css'
        ? 'text/css; charset=utf-8'
        : extension === '.map'
          ? 'application/json; charset=utf-8'
          : 'application/octet-stream'

  res.statusCode = 200
  res.setHeader('Content-Type', contentType)
  fs.createReadStream(filePath).pipe(res)
  return true
}

createServer((req, res) => {
  const pathname = parse(req.url || '/', false).pathname || '/'

  if (pathname.startsWith('/_next/static/')) {
    if (sendStaticAsset(res, pathname)) {
      return
    }
  }

  const handler = handlers[pathname]

  if (!handler) {
    res.statusCode = 404
    res.end('Not Found')
    return
  }

  handler(req, res, {
    waitUntil: () => {},
  }).catch((err) => {
    console.error(err)
    res.statusCode = 500
    res.end('Internal Server Error')
  })
}).listen(0, 'localhost', function onListen(err) {
  if (err) throw err
  const address = this.address()
  console.log(`- Local: http://localhost:${address.port}`)
})
