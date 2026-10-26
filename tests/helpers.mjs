// Test doubles: a plain HTTP upstream, an HTTP CONNECT proxy and a SOCKS5
// proxy. They are deliberately small and independent of the plugin code so the
// relay is tested against the wire protocol, not against itself.

import http from "node:http"
import net from "node:net"

export function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve(server.address().port)
    })
  })
}

export function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections?.()
  })
}

export async function startUpstream() {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/stream")) {
      res.writeHead(200, { "content-type": "text/plain", "transfer-encoding": "chunked" })
      res.write("first|")
      setTimeout(() => res.end("second"), 40)
      return
    }

    const chunks = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8")
      const payload = JSON.stringify({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(payload)
    })
  })

  const port = await listen(server)
  return { port, server, close: () => closeServer(server) }
}

export async function startHttpProxy({ auth, target } = {}) {
  const connects = []
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    res.writeHead(405)
    res.end()
  })

  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })

  server.on("connect", (req, clientSocket, head) => {
    sockets.add(clientSocket)
    clientSocket.once("close", () => sockets.delete(clientSocket))
    connects.push({ target: req.url, authorization: req.headers["proxy-authorization"] })

    if (auth && req.headers["proxy-authorization"] !== auth) {
      clientSocket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
      return
    }
    if (req.url?.startsWith("blocked")) {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n")
      return
    }

    const [host, port] = String(req.url).split(":")
    const destination = target ?? { host, port: Number(port) }
    const upstream = net.connect(destination.port, destination.host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head?.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })

    upstream.on("error", () => clientSocket.destroy())
    clientSocket.on("error", () => upstream.destroy())
  })

  const port = await listen(server)
  return {
    port,
    connects,
    server,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await closeServer(server)
    },
  }
}

// --- SOCKS5 ---------------------------------------------------------------

class Reader {
  constructor(socket) {
    this.socket = socket
    this.buffer = Buffer.alloc(0)
    this.done = false
    this.error = undefined
    this.wake = undefined

    this.onData = (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
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
    socket.once("error", this.onError)
  }

  notify() {
    const wake = this.wake
    this.wake = undefined
    if (wake) wake()
  }

  async read(size) {
    while (this.buffer.length < size) {
      if (this.done) throw this.error ?? new Error("closed")
      await new Promise((resolve) => {
        this.wake = resolve
      })
    }
    const out = this.buffer.subarray(0, size)
    this.buffer = this.buffer.subarray(size)
    return out
  }

  detach() {
    this.socket.off("data", this.onData)
    this.socket.off("end", this.onEnd)
    this.socket.off("error", this.onError)
    const buffered = this.buffer
    this.buffer = Buffer.alloc(0)
    return buffered
  }
}

export async function startSocks5Proxy({ username, password, target } = {}) {
  const requests = []
  const sockets = new Set()

  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    const reader = new Reader(socket)

    void (async () => {
      const greeting = await reader.read(2)
      const methods = await reader.read(greeting[1])

      const wantsAuth = username !== undefined
      const method = wantsAuth ? 0x02 : 0x00
      if (wantsAuth && !methods.includes(0x02)) {
        socket.destroy()
        return
      }
      socket.write(Buffer.from([0x05, method]))

      if (wantsAuth) {
        const [, nameLength] = await reader.read(2)
        const name = (await reader.read(nameLength)).toString("utf8")
        const [passLength] = await reader.read(1)
        const pass = (await reader.read(passLength)).toString("utf8")
        if (name !== username || pass !== password) {
          socket.end(Buffer.from([0x01, 0x01]))
          return
        }
        socket.write(Buffer.from([0x01, 0x00]))
      }

      const [version, command, , addressType] = await reader.read(4)
      let address
      if (addressType === 0x01) {
        address = Array.from(await reader.read(4)).join(".")
      } else if (addressType === 0x03) {
        const [length] = await reader.read(1)
        address = (await reader.read(length)).toString("utf8")
      } else if (addressType === 0x04) {
        address = "ipv6"
        await reader.read(16)
      }
      const port = (await reader.read(2)).readUInt16BE(0)

      requests.push({ version, command, addressType, address, port })

      const destination = target ?? { host: address, port }
      const upstream = net.connect(destination.port, destination.host, () => {
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        const buffered = reader.detach()
        if (buffered.length > 0) upstream.write(buffered)
        upstream.pipe(socket)
        socket.pipe(upstream)
      })

      upstream.on("error", () => socket.destroy())
      socket.on("error", () => upstream.destroy())
    })().catch(() => socket.destroy())
  })

  const port = await listen(server)
  return {
    port,
    requests,
    server,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await closeServer(server)
    },
  }
}
