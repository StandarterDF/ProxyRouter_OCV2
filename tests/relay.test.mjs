import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"

import { parseProxy, redactProxy, openTunnel } from "../plugin/dialer.js"
import { relayBaseURL, startRelay } from "../plugin/relay.js"
import { startHttpProxy, startSocks5Proxy, startUpstream } from "./helpers.mjs"

const AUTH = "Basic " + Buffer.from("user:pass", "utf8").toString("base64")

// The URL host is deliberately unresolvable: if the relay ever bypassed the
// tunnel and connected directly, these tests would fail with DNS errors.
const FAKE_HOST = "relay.invalid"

async function setupHttpProxyRelay({ proxyOptions, proxyAuth = false } = {}) {
  const upstream = await startUpstream()
  const proxy = await startHttpProxy({ ...proxyOptions, target: { host: "127.0.0.1", port: upstream.port } })
  const proxyURL = proxyAuth
    ? `http://user:pass@127.0.0.1:${proxy.port}`
    : `http://127.0.0.1:${proxy.port}`
  const relay = await startRelay({
    proxy: parseProxy(proxyURL),
    secure: false,
    upstreamPort: upstream.port,
  })
  relay.allowHost(FAKE_HOST)
  relay.allowHost("blocked")
  return { upstream, proxy, relay }
}

function teardown(t, { relay, proxy, upstream }) {
  t.after(async () => {
    await relay.close()
    await proxy.close()
    await upstream.close()
  })
}

test("relay forwards method, path, query, headers and body through an HTTP proxy", async (t) => {
  const context = await setupHttpProxyRelay()
  teardown(t, context)
  const { upstream, proxy, relay } = context

  const response = await fetch(`http://127.0.0.1:${relay.port}/${FAKE_HOST}/echo?x=1&y=2`, {
    method: "POST",
    headers: { "x-test": "yes", "content-type": "text/plain" },
    body: "hello relay",
  })

  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.method, "POST")
  assert.equal(payload.url, "/echo?x=1&y=2")
  assert.equal(payload.body, "hello relay")
  assert.equal(payload.headers["x-test"], "yes")
  assert.equal(payload.headers.host, FAKE_HOST)

  assert.equal(proxy.connects.length, 1)
  assert.equal(proxy.connects[0].target, `${FAKE_HOST}:${upstream.port}`)
})

test("relay strips hop-by-hop headers and proxy credentials", async (t) => {
  const context = await setupHttpProxyRelay()
  teardown(t, context)
  const { relay } = context

  const response = await fetch(`http://127.0.0.1:${relay.port}/${FAKE_HOST}/echo`, {
    headers: {
      "proxy-authorization": "Basic c2VjcmV0",
      "proxy-connection": "keep-alive",
      connection: "keep-alive",
      "x-keep": "1",
    },
  })
  const payload = await response.json()

  assert.equal(payload.headers["proxy-authorization"], undefined)
  assert.equal(payload.headers["proxy-connection"], undefined)
  assert.equal(payload.headers["x-keep"], "1")
})

test("relay streams the response instead of buffering it", async (t) => {
  const context = await setupHttpProxyRelay()
  teardown(t, context)
  const { relay } = context

  const chunks = await new Promise((resolve, reject) => {
    const seen = []
    const request = http.get(`http://127.0.0.1:${relay.port}/${FAKE_HOST}/stream`, (response) => {
      response.on("data", (chunk) => seen.push(chunk.toString("utf8")))
      response.on("end", () => resolve(seen))
    })
    request.on("error", reject)
  })

  assert.ok(chunks.length >= 2, `expected at least two chunks, got ${JSON.stringify(chunks)}`)
  assert.equal(chunks.join(""), "first|second")
})

test("relay returns 502 when the proxy refuses the tunnel", async (t) => {
  const context = await setupHttpProxyRelay()
  teardown(t, context)
  const { relay } = context

  const response = await fetch(`http://127.0.0.1:${relay.port}/blocked/echo`)
  assert.equal(response.status, 502)
  const payload = await response.json()
  assert.match(payload.error, /403/)
})

test("relay exposes health and rejects unknown paths", async (t) => {
  const context = await setupHttpProxyRelay()
  teardown(t, context)
  const { relay } = context

  const health = await fetch(`http://127.0.0.1:${relay.port}/__relay/health`).then((r) => r.json())
  assert.equal(health.ok, true)

  const missing = await fetch(`http://127.0.0.1:${relay.port}/`)
  assert.equal(missing.status, 404)
})

test("relay refuses hosts that no model is configured for", async (t) => {
  const context = await setupHttpProxyRelay()
  teardown(t, context)
  const { relay } = context

  const response = await fetch(`http://127.0.0.1:${relay.port}/evil.example/echo`)
  assert.equal(response.status, 403)
})

test("relay sends proxy authentication credentials", async (t) => {
  const context = await setupHttpProxyRelay({ proxyOptions: { auth: AUTH }, proxyAuth: true })
  teardown(t, context)
  const { proxy, relay } = context

  const response = await fetch(`http://127.0.0.1:${relay.port}/${FAKE_HOST}/echo`)
  assert.equal(response.status, 200)
  assert.equal(proxy.connects[0].authorization, AUTH)
})

test("relay works through SOCKS5h without authentication", async (t) => {
  const upstream = await startUpstream()
  const socks = await startSocks5Proxy({ target: { host: "127.0.0.1", port: upstream.port } })
  const relay = await startRelay({
    proxy: parseProxy(`socks5h://127.0.0.1:${socks.port}`),
    secure: false,
    upstreamPort: upstream.port,
  })
  relay.allowHost(FAKE_HOST)
  t.after(async () => {
    await relay.close()
    await socks.close()
    await upstream.close()
  })

  const response = await fetch(`http://127.0.0.1:${relay.port}/${FAKE_HOST}/echo`)
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.headers.host, FAKE_HOST)

  assert.equal(socks.requests.length, 1)
  assert.equal(socks.requests[0].address, FAKE_HOST)
  assert.equal(socks.requests[0].addressType, 0x03)
})

test("relay works through SOCKS5h with username and password", async (t) => {
  const upstream = await startUpstream()
  const socks = await startSocks5Proxy({
    username: "user",
    password: "pass",
    target: { host: "127.0.0.1", port: upstream.port },
  })
  const relay = await startRelay({
    proxy: parseProxy(`socks5h://user:pass@127.0.0.1:${socks.port}`),
    secure: false,
    upstreamPort: upstream.port,
  })
  relay.allowHost(FAKE_HOST)
  t.after(async () => {
    await relay.close()
    await socks.close()
    await upstream.close()
  })

  const response = await fetch(`http://127.0.0.1:${relay.port}/${FAKE_HOST}/echo`)
  assert.equal(response.status, 200)
  assert.equal(socks.requests.length, 1)
})

test("socks5 resolves the hostname locally, socks5h sends it to the proxy", async () => {
  const upstream = await startUpstream()
  const local = await startSocks5Proxy({ target: { host: "127.0.0.1", port: upstream.port } })
  const remote = await startSocks5Proxy({ target: { host: "127.0.0.1", port: upstream.port } })

  try {
    const localSocket = await openTunnel({
      host: "localhost",
      port: upstream.port,
      proxy: parseProxy(`socks5://127.0.0.1:${local.port}`),
    })
    localSocket.destroy()

    const remoteSocket = await openTunnel({
      host: "localhost",
      port: upstream.port,
      proxy: parseProxy(`socks5h://127.0.0.1:${remote.port}`),
    })
    remoteSocket.destroy()

    assert.equal(local.requests[0].addressType, 0x01)
    assert.equal(local.requests[0].address, "127.0.0.1")
    assert.equal(remote.requests[0].addressType, 0x03)
    assert.equal(remote.requests[0].address, "localhost")
  } finally {
    await local.close()
    await remote.close()
    await upstream.close()
  }
})

test("relayBaseURL maps a provider baseURL onto the relay path", () => {
  assert.equal(
    relayBaseURL(1234, "https://opencode.ai/inference/go/openai/v1"),
    "http://127.0.0.1:1234/opencode.ai/inference/go/openai/v1",
  )
  assert.equal(relayBaseURL(1234, "https://opencode.ai/"), "http://127.0.0.1:1234/opencode.ai")
  assert.throws(() => relayBaseURL(1234, "http://127.0.0.1:8080/v1"), /only https/)
})

test("parseProxy validates schemes and redactProxy hides credentials", () => {
  assert.equal(parseProxy("socks5h://user:p%40ss@127.0.0.1:1080").password, "p@ss")
  assert.equal(parseProxy(""), null)
  assert.throws(() => parseProxy("ftp://127.0.0.1:21"), /unsupported proxy protocol/)
  assert.throws(() => parseProxy("not a url"), /proxy must be a URL/)

  const redacted = redactProxy("socks5h://user:secret@127.0.0.1:1080")
  assert.ok(!redacted.includes("secret"))
  assert.match(redacted, /\*\*\*/)
})
