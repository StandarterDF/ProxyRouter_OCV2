// Manual integration test: real forward proxy, real TLS upstream.
//
//   set PROXY_ROUTER_TEST_PROXY=http://192.168.0.250:2081
//   node tests/integration.mjs
//
// Not part of `node --test`: it needs a working proxy and internet access.

import { parseProxy } from "../plugin/dialer.js"
import { startRelay } from "../plugin/relay.js"

const rawProxy = process.env.PROXY_ROUTER_TEST_PROXY
if (!rawProxy) {
  console.error("PROXY_ROUTER_TEST_PROXY is not set (example: http://127.0.0.1:2081)")
  process.exit(2)
}

const relay = await startRelay({ proxy: parseProxy(rawProxy), log: (message) => console.log("relay:", message) })
relay.allowHost("opencode.ai")

try {
  const url = `http://127.0.0.1:${relay.port}/opencode.ai/inference/v1/models`
  const response = await fetch(url)
  const body = await response.text()

  console.log("status:", response.status)
  if (!response.ok) {
    console.error(body.slice(0, 500))
    process.exit(1)
  }

  const payload = JSON.parse(body)
  const ids = (payload.data ?? []).map((model) => model.id)
  console.log(`models: ${ids.length}`)
  console.log(`has beam-free: ${ids.includes("beam-free")}`)
  console.log(`has muse-spark-1.3: ${ids.includes("muse-spark-1.3")}`)
} finally {
  await relay.close()
}
