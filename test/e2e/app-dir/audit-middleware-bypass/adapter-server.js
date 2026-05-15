const { createServer } = require('http')
const fs = require('fs')
const path = require('path')
const { Readable } = require('stream')
const { pathToFileURL } = require('url')
const { resolveRoutes } = require('@next/routing')

require('next/dist/server/node-environment')

const buildComplete = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'build-complete.json'), 'utf8')
)

const pathnameToOutput = new Map()
for (const output of [
  ...buildComplete.outputs.pages,
  ...buildComplete.outputs.pagesApi,
  ...buildComplete.outputs.appPages,
  ...buildComplete.outputs.appRoutes,
]) {
  pathnameToOutput.set(output.pathname, output)
}

const nodeHandlerCache = new Map()
async function loadNodeHandler(filePath) {
  if (!nodeHandlerCache.has(filePath)) {
    const mod = require(filePath)
    if (typeof mod.handler !== 'function') {
      throw new Error(`Entrypoint handler missing at ${filePath}`)
    }
    nodeHandlerCache.set(filePath, mod.handler)
  }

  return nodeHandlerCache.get(filePath)
}

let middlewareHandlerPromise
async function loadMiddlewareHandler() {
  if (!buildComplete.outputs.middleware) {
    return undefined
  }

  if (!middlewareHandlerPromise) {
    middlewareHandlerPromise = (async () => {
      if (buildComplete.outputs.middleware.edgeRuntime) {
        const { modulePath, entryKey, handlerExport } =
          buildComplete.outputs.middleware.edgeRuntime

        await import(pathToFileURL(modulePath).href)
        const entry = await globalThis._ENTRIES[entryKey]
        return entry[handlerExport]
      }

      const mod = require(buildComplete.outputs.middleware.filePath)
      return mod.handler || mod.default
    })()
  }

  return middlewareHandlerPromise
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

async function sendWebResponse(webResponse, res) {
  res.statusCode = webResponse.status
  webResponse.headers.forEach((value, key) => {
    res.setHeader(key, value)
  })

  const body = Buffer.from(await webResponse.arrayBuffer())
  res.end(body)
}

function toHeaders(headers) {
  const result = new Headers()

  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        result.append(key, item)
      }
    } else if (typeof value === 'string') {
      result.set(key, value)
    }
  }

  return result
}

function toQueryString(query) {
  const params = new URLSearchParams()

  for (const [key, value] of Object.entries(query || {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, item)
      }
    } else if (typeof value === 'string') {
      params.set(key, value)
    }
  }

  const queryString = params.toString()
  return queryString ? `?${queryString}` : ''
}

const pathnames = [
  ...buildComplete.outputs.pages,
  ...buildComplete.outputs.pagesApi,
  ...buildComplete.outputs.appPages,
  ...buildComplete.outputs.appRoutes,
  ...buildComplete.outputs.staticFiles,
].map((output) => output.pathname)

createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || '/', 'http://localhost')

    if (requestUrl.pathname.startsWith('/_next/static/')) {
      if (sendStaticAsset(res, requestUrl.pathname)) {
        return
      }
    }

    let middlewareResponse
    const result = await resolveRoutes({
      url: requestUrl,
      buildId: buildComplete.buildId,
      basePath: buildComplete.config.basePath || '',
      i18n: buildComplete.config.i18n,
      headers: toHeaders(req.headers),
      requestBody: Readable.toWeb(req),
      pathnames,
      routes: {
        ...buildComplete.routing,
        middlewareMatchers:
          buildComplete.outputs.middleware?.config?.matchers || [],
      },
      invokeMiddleware: async (ctx) => {
        const handler = await loadMiddlewareHandler()
        if (!handler) {
          return {}
        }

        const body =
          req.method === 'GET' || req.method === 'HEAD'
            ? undefined
            : ctx.requestBody
        const response = await handler(
          new Request(ctx.url, {
            method: req.method,
            headers: ctx.headers,
            body,
            duplex: body ? 'half' : undefined,
          }),
          {
            requestMeta: {
              relativeProjectDir: '.',
              hostname: 'localhost',
            },
            waitUntil: () => {},
          }
        )

        const rewrite = response.headers.get('x-middleware-rewrite')
        const location = response.headers.get('location')

        if (rewrite) {
          return {
            responseHeaders: new Headers(response.headers),
            rewrite: new URL(rewrite, ctx.url),
          }
        }

        if (location && response.status >= 300 && response.status < 400) {
          return {
            responseHeaders: new Headers(response.headers),
            redirect: {
              url: new URL(location, ctx.url),
              status: response.status,
            },
          }
        }

        if (response.headers.get('x-middleware-next') === '1') {
          return {
            responseHeaders: new Headers(response.headers),
          }
        }

        middlewareResponse = response
        return { bodySent: true }
      },
    })

    if (result.middlewareResponded) {
      if (!middlewareResponse) {
        res.statusCode = 500
        res.end('Invariant: missing middleware response')
        return
      }

      await sendWebResponse(middlewareResponse, res)
      return
    }

    if (result.redirect) {
      res.statusCode = result.redirect.status
      res.setHeader('location', result.redirect.url.toString())
      res.end()
      return
    }

    const invocationPathname =
      result.invocationTarget?.pathname ||
      result.resolvedPathname ||
      requestUrl.pathname
    const output = pathnameToOutput.get(invocationPathname)

    if (!output) {
      res.statusCode = 404
      res.end('Not Found')
      return
    }

    const handler = await loadNodeHandler(output.filePath)
    req.url = `${invocationPathname}${toQueryString(result.invocationTarget?.query)}`

    await handler(req, res, {
      waitUntil: () => {},
      requestMeta: {
        relativeProjectDir: '.',
        hostname: 'localhost',
      },
    })
  } catch (err) {
    console.error(err)
    res.statusCode = 500
    res.end('Internal Server Error')
  }
}).listen(0, 'localhost', function onListen(err) {
  if (err) throw err
  const address = this.address()
  console.log(`- Local: http://localhost:${address.port}`)
})
