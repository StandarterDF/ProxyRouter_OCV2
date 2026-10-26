// Local reverse relay.
//
// The relay listens on loopback and understands URLs of the form
//
//     http://127.0.0.1:<port>/<upstream-host>/<original-path>
//
// It dials <upstream-host>:443 through the configured forward proxy
// (HTTP CONNECT or SOCKS5), then replays the original method, path, headers
// and body. Responses are streamed back without buffering, so SSE works.
//
// The upstream host is part of the path instead of a header: model requests
// carry provider credentials, and OpenCode gives us no supported way to add a
// routing header to every call.

import http from "node:http"
import https from "node:https"
import { openTunnel, openTlsTunnel, redactProxy } from "./dialer.js"

const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i
const HOP_BY_HOP = new Set([
  "connection",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])
const HEALTH_PATH = "/__relay/health"

function sendJson(res, status, payload) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  })
  res.end(body)
}

export function relayBaseURL(port, originalBaseURL, host = "127.0.0.1") {
  const url = new URL(originalBaseURL)
  if (url.protocol !== "https:") {
    throw new Error(`only https upstreams can be relayed (got ${url.protocol})`)
  }
  const path = url.pathname === "/" ? "" : url.pathname
  return `http://${host}:${port}/${url.host}${path}`
}

function resolveTarget(rawUrl) {
  const parsed = new URL(rawUrl, "http://relay.local")

  if (parsed.pathname === HEALTH_PATH) return { health: true }

  const trimmed = parsed.pathname.replace(/^\//, "")
  const slash = trimmed.indexOf("/")
  const host = slash === -1 ? trimmed : trimmed.slice(0, slash)
  const rest = slash === -1 ? "/" : trimmed.slice(slash)

  if (!host || !HOST_RE.test(host)) return null
  return { host, path: rest + parsed.search }
}

function requestHeaders(rawHeaders, upstreamHost) {
  const headers = {}
  for (const [name, value] of Object.entries(rawHeaders)) {
    const key = name.toLowerCase()
    if (HOP_BY_HOP.has(key) || key === "host") continue
    headers[key] = value
  }
  headers.host = upstreamHost
  return headers
}

function responseHeaders(rawHeaders) {
  const headers = {}
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    headers[name] = value
  }
  return headers
}

export async function startRelay({
  proxy = null,
  host = "127.0.0.1",
  port = 0,
  secure = true,
  upstreamPort = secure ? 443 : 80,
  tls = {},
  log = () => {},
} = {}) {
  const sockets = new Set()
  const allowedHosts = new Set()
  const startedAt = Date.now()

  const server = http.createServer(async (req, res) => {
    const target = resolveTarget(req.url ?? "/")

    if (target?.health) {
      sendJson(res, 200, {
        ok: true,
        proxy: redactProxy(proxy),
        secure,
        upstreamPort,
        hosts: [...allowedHosts],
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      })
      return
    }

    if (!target) {
      sendJson(res, 404, {
        error: "unknown relay path",
        hint: "expected http://127.0.0.1:<port>/<upstream-host>/<path>",
      })
      return
    }

    if (!allowedHosts.has(target.host)) {
      sendJson(res, 403, { error: `relay host is not allowed: ${target.host}` })
      return
    }

    let socket
    try {
      socket = secure
        ? await openTlsTunnel({ host: target.host, port: upstreamPort, proxy, tls })
        : await openTunnel({ host: target.host, port: upstreamPort, proxy })
    } catch (error) {
      log(`dial ${target.host} failed: ${error.message}`)
      sendJson(res, 502, { error: `relay could not reach ${target.host}: ${error.message}` })
      return
    }

    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))

    const transport = secure ? https : http
    // A per-request agent that hands the already-established socket back to
    // Node. Passing `agent: false` with `createConnection` does NOT work: the
    // client ignores it and opens its own connection to host:port.
    const agent = new transport.Agent({ keepAlive: false, maxSockets: 1 })
    agent.createConnection = () => socket

    let upstream
    try {
      upstream = transport.request({
        host: target.host,
        port: upstreamPort,
        method: req.method,
        path: target.path,
        headers: requestHeaders(req.headers, target.host),
        agent,
      })
    } catch (error) {
      agent.destroy()
      socket.destroy()
      sendJson(res, 502, { error: `relay could not build the upstream request: ${error.message}` })
      return
    }

    upstream.on("response", (upstreamRes) => {
      if (log) log(`${req.method} ${target.host}${target.path} -> ${upstreamRes.statusCode}`)
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, responseHeaders(upstreamRes.headers))
      upstreamRes.pipe(res)
      upstreamRes.on("error", () => res.destroy())
    })

    upstream.on("error", (error) => {
      log(`${req.method} ${target.host}${target.path} failed: ${error.message}`)
      if (res.headersSent) res.destroy()
      else sendJson(res, 502, { error: `relay request failed: ${error.message}` })
    })

    res.on("close", () => {
      if (!res.writableFinished) {
        upstream.destroy()
        socket.destroy()
      }
    })

    req.on("aborted", () => {
      upstream.destroy()
      socket.destroy()
    })

    req.pipe(upstream)
  })

  server.on("connection", (socket) => {
    socket.setNoDelay(true)
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => {
      server.off("error", reject)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === "string") {
    server.close()
    throw new Error("relay failed to bind a TCP port")
  }

  return {
    port: address.port,
    host,
    url: `http://${host}:${address.port}`,
    allowHost(upstreamHost) {
      allowedHosts.add(upstreamHost)
    },
    hosts() {
      return [...allowedHosts]
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise((resolve) => {
        if (!server.listening) return resolve()
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
  }
}
