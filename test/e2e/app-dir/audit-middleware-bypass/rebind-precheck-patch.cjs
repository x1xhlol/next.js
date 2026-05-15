const dnsPromises = require('dns/promises')

const originalLookup = dnsPromises.lookup

dnsPromises.lookup = async function patchedLookup(hostname, options) {
  if (hostname === 'localhost') {
    return [{ address: '93.184.216.34', family: 4 }]
  }

  return originalLookup.call(this, hostname, options)
}
