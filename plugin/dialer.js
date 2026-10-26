// Proxy dialers for the reverse relay.
//
// Supported proxies:
//   * direct connection (no proxy)
//   * HTTP proxy          http://[user:pass@]host:port
//   * HTTPS proxy         https://[user:pass@]host:port   (TLS to the proxy itself)
//   * SOCKS5              socks5://[user:pass@]host:port  (hostname resolved locally)
//   * SOCKS5h             socks5h://[user:pass@]host:port (hostname resolved by the proxy)
//
// Everything returns a connected socket. openTlsTunnel() wraps it into TLS.

import net from "node:net"
import tls from "node:tls"
import dns from "node:dns/promises"

const SUPPORTED = new Set(["http", "https", "socks5", "socks5h"])
const DEFAULT_PORT = { http: 8080, https: 443, socks5: 1080, socks5h: 1080 }
const CONNECT_TIMEOUT = 30_000
const MAX_HEADER_BYTES = 64 * 1024

// ---------------------------------------------------------------------------
// Proxy URL
// ---------------------------------------------------------------------------

export function redactProxy(value) {
  if (!value) return ""

  const raw = typeof value === "string" ? value : `${value.protocol}://${value.host}:${value.port}`
  if (typeof value !== "string") {
    return value.username || value.password
      ? `${value.protocol}://***:***@${value.host}:${value.port}`
      : raw
  }

  try {
    const url = new URL(raw)
    if (!url.username && !url.password) return raw
    url.username = url.username ? "***" : ""
    url.password = url.password ? "***" : ""
    return url.toString()
  } catch {
    return "<invalid proxy URL>"
  }
}

export function parseProxy(value) {
  if (value === undefined || value === null || value === "") return null
  let url
  try {
    url = new URL(String(value))
  } catch {
    throw new Error("proxy must be a URL like http://host:port or socks5h://host:port")
  }

  const protocol = url.protocol.replace(/:$/, "").toLowerCase()
  if (!SUPPORTED.has(protocol)) {
    throw new Error(`unsupported proxy protocol "${protocol}" (use http, https, socks5 or socks5h)`)
  }
  if (!url.hostname) throw new Error("proxy URL has no host")

  const port = url.port ? Number(url.port) : DEFAULT_PORT[protocol]
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("proxy URL has an invalid port")

  return {
    protocol,
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
  }
}

// ---------------------------------------------------------------------------
// Small buffered reader (SOCKS and CONNECT handshakes are byte oriented)
// ---------------------------------------------------------------------------

class ByteReader {
  constructor(socket) {
    this.socket = socket
    this.buffer = Buffer.alloc(0)
    this.done = false
    this.error = undefined
    this.wake = undefined

    this.onData = (chunk) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
      this.notify()
    }
    this.onEnd = () => {
      this.done = true
      this.notify()
    }
    this.onError = (error) => {
      this.error = error
      this.done = true
      this.notify()
    }

    socket.on("data", this.onData)
    socket.once("end", this.onEnd)
    socket.once("close", this.onEnd)
    socket.once("error", this.onError)
  }

  notify() {
    const wake = this.wake
    this.wake = undefined
    if (wake) wake()
  }

  next() {
    return new Promise((resolve) => {
      this.wake = resolve
    })
  }

  async read(size) {
    while (this.buffer.length < size) {
      if (this.done) throw this.error ?? new Error("connection closed while reading")
      await this.next()
    }
    const out = this.buffer.subarray(0, size)
    this.buffer = this.buffer.subarray(size)
    return out
  }

  async readUntil(delimiter, limit = MAX_HEADER_BYTES) {
    while (true) {
      const index = this.buffer.indexOf(delimiter)
      if (index >= 0) {
        const end = index + delimiter.length
        const out = this.buffer.subarray(0, end)
        this.buffer = this.buffer.subarray(end)
        return out
      }
      if (this.buffer.length > limit) throw new Error("proxy response headers are too large")
      if (this.done) throw this.error ?? new Error("connection closed while reading")
      await this.next()
    }
  }

  // Stop reading and hand the socket back, preserving any buffered bytes.
  detach() {
    this.socket.off("data", this.onData)
    this.socket.off("end", this.onEnd)
    this.socket.off("close", this.onEnd)
    this.socket.off("error", this.onError)
    const buffered = this.buffer
    this.buffer = Buffer.alloc(0)
    return buffered
  }
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

function waitFor(socket, event, timeout, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`${label} timed out after ${timeout}ms`))
    }, timeout)

    const onEvent = () => {
      cleanup()
      resolve(socket)
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      clearTimeout(timer)
      socket.off(event, onEvent)
      socket.off("error", onError)
    }

    socket.once(event, onEvent)
    socket.once("error", onError)
  })
}

async function connectDirect(host, port, timeout) {
  const socket = net.connect({ host, port })
  return await waitFor(socket, "connect", timeout, `connect to ${host}:${port}`)
}

async function connectProxy(proxy, timeout) {
  if (proxy.protocol === "https") {
    const socket = tls.connect({
      host: proxy.host,
      port: proxy.port,
      servername: proxy.host,
      ALPNProtocols: ["http/1.1"],
    })
    return await waitFor(socket, "secureConnect", timeout, `connect to proxy ${proxy.host}:${proxy.port}`)
  }

  const socket = net.connect({ host: proxy.host, port: proxy.port })
  return await waitFor(socket, "connect", timeout, `connect to proxy ${proxy.host}:${proxy.port}`)
}

// ---------------------------------------------------------------------------
// HTTP CONNECT
// ---------------------------------------------------------------------------

async function httpConnect(socket, proxy, host, port) {
  const reader = new ByteReader(socket)
  const authority = `${host}:${port}`
  const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`, "Proxy-Connection: keep-alive"]

  if (proxy.username || proxy.password) {
    const credentials = `${proxy.username ?? ""}:${proxy.password ?? ""}`
    lines.push(`Proxy-Authorization: Basic ${Buffer.from(credentials, "utf8").toString("base64")}`)
  }

  socket.write(`${lines.join("\r\n")}\r\n\r\n`)

  let head
  try {
    head = await reader.readUntil(Buffer.from("\r\n\r\n"))
  } finally {
    const buffered = reader.detach()
    if (buffered.length > 0) socket.unshift(buffered)
  }

  const statusLine = head.toString("latin1").split("\r\n", 1)[0]
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine)
  if (!match) throw new Error(`proxy returned a malformed CONNECT response: ${statusLine.slice(0, 80)}`)

  const status = Number(match[1])
  if (status < 200 || status >= 300) {
    throw new Error(`proxy refused CONNECT to ${authority} with HTTP ${status}`)
  }

  return socket
}

// ---------------------------------------------------------------------------
// SOCKS5
// ---------------------------------------------------------------------------

function ipv4Bytes(address) {
  return Buffer.from(address.split(".").map((part) => Number(part) & 0xff))
}

async function socks5Connect(socket, proxy, host, port) {
  const reader = new ByteReader(socket)
  const methods = proxy.username || proxy.password ? [0x00, 0x02] : [0x00]

  socket.write(Buffer.from([0x05, methods.length, ...methods]))
  const [version, method] = await reader.read(2)
  if (version !== 0x05) throw new Error("proxy is not a SOCKS5 server")

  if (method === 0xff) throw new Error("SOCKS5 proxy rejected all offered authentication methods")

  if (method === 0x02) {
    if (!proxy.username) throw new Error("SOCKS5 proxy requires a username and password")
    const user = Buffer.from(proxy.username, "utf8")
    const pass = Buffer.from(proxy.password ?? "", "utf8")
    socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]))
    const [, status] = await reader.read(2)
    if (status !== 0x00) throw new Error("SOCKS5 proxy rejected the credentials")
  } else if (method !== 0x00) {
    throw new Error(`SOCKS5 proxy offered unsupported authentication method 0x${method.toString(16)}`)
  }

  let addressType
  let addressBytes

  if (net.isIPv4(host)) {
    addressType = 0x01
    addressBytes = ipv4Bytes(host)
  } else if (net.isIPv6(host)) {
    // Sending an IPv6 literal as a domain name is not valid; resolve it is not
    // trivial either, so keep this explicit instead of failing mysteriously.
    throw new Error("SOCKS5 relay does not support IPv6 targets")
  } else if (proxy.protocol === "socks5h") {
    const name = Buffer.from(host, "utf8")
    addressType = 0x03
    addressBytes = Buffer.concat([Buffer.from([name.length]), name])
  } else {
    const resolved = await dns.lookup(host, { family: 4 })
    addressType = 0x01
    addressBytes = ipv4Bytes(resolved.address)
  }

  const portBytes = Buffer.from([(port >> 8) & 0xff, port & 0xff])
  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, addressType]), addressBytes, portBytes]))

  const head = await reader.read(4)
  if (head[0] !== 0x05) throw new Error("invalid SOCKS5 reply")
  if (head[1] !== 0x00) throw new Error(`SOCKS5 proxy could not connect (code 0x${head[1].toString(16)})`)

  const replyType = head[3]
  if (replyType === 0x01) await reader.read(4)
  else if (replyType === 0x04) await reader.read(16)
  else if (replyType === 0x03) {
    const [length] = await reader.read(1)
    await reader.read(length)
  } else throw new Error("invalid SOCKS5 address type in reply")

  await reader.read(2)

  const buffered = reader.detach()
  if (buffered.length > 0) socket.unshift(buffered)
  return socket
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function openTunnel({ host, port = 443, proxy = null, timeout = CONNECT_TIMEOUT }) {
  if (!proxy) return await connectDirect(host, port, timeout)

  const socket = await connectProxy(proxy, timeout)
  try {
    if (proxy.protocol === "socks5" || proxy.protocol === "socks5h") {
      return await socks5Connect(socket, proxy, host, port)
    }
    return await httpConnect(socket, proxy, host, port)
  } catch (error) {
    socket.destroy()
    throw error
  }
}

export async function openTlsTunnel({ host, port = 443, proxy = null, timeout = CONNECT_TIMEOUT, tls: tlsOptions = {} }) {
  const socket = await openTunnel({ host, port, proxy, timeout })
  const secure = tls.connect({
    socket,
    servername: tlsOptions.servername ?? host,
    ALPNProtocols: ["http/1.1"],
    ca: tlsOptions.ca,
    rejectUnauthorized: tlsOptions.rejectUnauthorized ?? true,
  })

  try {
    return await waitFor(secure, "secureConnect", timeout, `TLS handshake with ${host}`)
  } catch (error) {
    socket.destroy()
    throw error
  }
}
