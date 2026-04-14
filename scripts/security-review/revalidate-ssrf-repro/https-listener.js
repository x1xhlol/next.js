const fs = require('fs')
const https = require('https')
const path = require('path')

const port = Number(process.env.PORT || 4443)
const certDir = path.join(
  __dirname,
  '../../../test/integration/custom-server/ssh'
)

const server = https.createServer(
  {
    key: fs.readFileSync(path.join(certDir, 'localhost-key.pem')),
    cert: fs.readFileSync(path.join(certDir, 'localhost.pem')),
  },
  (req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      console.log(
        JSON.stringify(
          {
            method: req.method,
            url: req.url,
            headers: req.headers,
            body,
          },
          null,
          2
        )
      )
      res.statusCode = 200
      res.setHeader('x-nextjs-cache', 'REVALIDATED')
      res.end('ok')
    })
  }
)

server.listen(port, '127.0.0.1', () => {
  console.log(`listener ready on https://127.0.0.1:${port}`)
})
