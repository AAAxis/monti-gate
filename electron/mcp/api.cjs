// The MCP server's client for the launcher's own loopback automation API.
//
// Everything that is not CDP goes through here: listing profiles, launching
// one, assigning a proxy. The bearer token is the scoped, revocable key the
// Integrations tab minted -- it arrives in the environment and is never logged,
// never echoed back in an error, and never passed on the command line (argv is
// world-readable through `ps`).

const http = require('node:http');

const REQUEST_TIMEOUT_MS = 30000;

// Raised for a non-2xx so the tool layer can turn it into an `isError` result
// carrying the API's own wording, which is usually more specific than anything
// this layer could invent.
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function request(base, token, method, routePath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(routePath, base);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {Authorization: `Bearer ${token}`};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          // Non-JSON body -- the status still tells us what happened.
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new ApiError(res.statusCode, parsed?.msg || `HTTP ${res.statusCode}`));
          return;
        }
        resolve(parsed || {});
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${routePath} timed out`)));
    // The overwhelmingly common cause: Scout Web is not running. Say that,
    // rather than surfacing a bare ECONNREFUSED.
    req.on('error', (error) => {
      reject(error.code === 'ECONNREFUSED' ?
        new Error('Scout Web is not running, or its local API is not ready yet') :
        error);
    });
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function createClient(base, token) {
  return {
    get: (routePath) => request(base, token, 'GET', routePath),
    post: (routePath, body) => request(base, token, 'POST', routePath, body || {}),
  };
}

module.exports = {ApiError, createClient};
