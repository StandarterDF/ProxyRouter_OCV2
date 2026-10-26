// Proxy Router — OpenCode V2 plugin.
//
// Keeps a small reverse relay on loopback and routes only the models you list
// through a forward proxy (HTTP CONNECT or SOCKS5). Everything else keeps
// talking to the provider directly.
//
// Why a relay and not HTTP_PROXY: OpenCode V2 runs provider traffic inside the
// background service, so a proxy exported in your shell (or set at runtime by
// a plugin) is not reliably visible to those requests. A per-model baseURL,
// on the other hand, is ordinary model configuration and can be changed at
// runtime with a model transform + reload.
//
// Options (opencode.json > plugins > options):
//   proxy      forward proxy URL (http, https, socks5, socks5h). Required.
//   models     model refs to route: "provider/model", "provider/*", "provider", "*".
//   enabled    start the relay on plugin load (default: true).
//   port       local relay port, 0 = ephemeral (default: 0).
//   host       local relay bind address (default: 127.0.0.1).
//   upstreams  per-provider upstream baseURL when the provider does not expose one.
//   log        verbose relay logging (default: false).

import { appendFileSync } from "node:fs"
import { parseProxy, redactProxy } from "./dialer.js"
import { relayBaseURL, startRelay } from "./relay.js"

const DEBUG_LOG = process.env.PROXY_ROUTER_DEBUG
const LOOPBACK = "127.0.0.1"

function log(message) {
  console.log(`[proxy-router] ${message}`)
  if (!DEBUG_LOG) return
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Ignore debug write failures.
  }
}

function normalizeTargets(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function matches(target, providerID, modelID) {
  if (target === "*" || target === "*/*") return true
  const slash = target.indexOf("/")
  if (slash === -1) return target === providerID
  const provider = target.slice(0, slash)
  const model = target.slice(slash + 1)
  if (provider !== "*" && provider !== providerID) return false
  return model === "*" || model === modelID
}

function parseAction(value) {
  const token = String(value ?? "").trim().split(/\s+/, 1)[0]?.toLowerCase() ?? ""
  if (["on", "1", "true", "enable", "start", "вкл", "включить"].includes(token)) return "on"
  if (["off", "0", "false", "disable", "stop", "выкл", "выключить"].includes(token)) return "off"
  if (["status", "state", "статус", ""].includes(token)) return "status"
  return "help"
}

export default {
  id: "opencode.proxy-router",

  async setup(ctx) {
    const options = ctx.options ?? {}
    const targets = normalizeTargets(options.models)
    const upstreams = options.upstreams && typeof options.upstreams === "object" ? options.upstreams : {}

    const state = {
      enabled: false,
      relay: null,
      applied: [],
      skipped: [],
      lastError: null,
    }

    let proxy = null
    let configError = null
    try {
      proxy = parseProxy(options.proxy)
      if (!proxy) configError = "option \"proxy\" is not set"
    } catch (error) {
      configError = error.message
    }

    if (targets.length === 0 && !configError) configError = "option \"models\" is empty"

    if (configError) log(`disabled: ${configError}`)

    // ---------------------------------------------------------------------
    // Model transform: point the selected models at the local relay.
    // ---------------------------------------------------------------------

    const registration = await ctx.model.transform((editor) => {
      state.applied = []
      state.skipped = []

      if (!state.enabled || !state.relay) return

      const relayPort = state.relay.port
      const relayPrefix = `http://${LOOPBACK}:${relayPort}/`

      for (const record of editor.provider.list()) {
        const providerID = record.provider.id
        const providerBase = record.provider.settings?.baseURL ?? upstreams[providerID]

        for (const model of editor.list(providerID)) {
          if (!targets.some((target) => matches(target, providerID, model.id))) continue

          const ref = `${providerID}/${model.id}`
          const original = model.settings?.baseURL ?? providerBase

          if (!original) {
            state.skipped.push(`${ref}: no baseURL (add it to options.upstreams)`)
            continue
          }

          if (String(original).startsWith(relayPrefix)) {
            state.applied.push(ref)
            continue
          }

          if (!String(original).startsWith("https://")) {
            state.skipped.push(`${ref}: only https upstreams can be relayed`)
            continue
          }

          let base
          try {
            state.relay.allowHost(new URL(original).host)
            base = relayBaseURL(relayPort, original, LOOPBACK)
          } catch (error) {
            state.skipped.push(`${ref}: ${error.message}`)
            continue
          }

          editor.update(providerID, model.id, (draft) => {
            draft.settings = { ...(draft.settings ?? {}), baseURL: base }
          })
          state.applied.push(ref)
        }
      }
    })

    // ---------------------------------------------------------------------
    // Runtime control
    // ---------------------------------------------------------------------

    let queue = Promise.resolve()
    function enqueue(task) {
      const run = queue.then(task, task)
      queue = run.catch(() => {})
      return run
    }

    async function apply() {
      try {
        await ctx.model.reload()
        await ctx.model.list()
      } catch (error) {
        log(`could not reload the model registry: ${error.message}`)
      }
    }

    async function enable() {
      if (state.enabled && state.relay) return statusText()
      if (configError) throw new Error(configError)
      if (!proxy) throw new Error("option \"proxy\" is not set")

      const port = Number.isInteger(options.port) ? options.port : 0
      const relay = await startRelay({
        proxy,
        port,
        host: LOOPBACK,
        log: options.log ? (message) => log(message) : () => {},
      })

      state.relay = relay
      state.enabled = true
      state.lastError = null
      await apply()

      if (state.applied.length === 0) {
        state.lastError = "no models matched the configured targets"
        log(`enabled on ${relay.url}, but ${state.lastError}`)
      } else {
        log(`enabled on ${relay.url} via ${redactProxy(options.proxy)}; routed ${state.applied.join(", ")}`)
      }

      for (const skipped of state.skipped) log(`skipped ${skipped}`)
      return statusText()
    }

    async function disable() {
      state.enabled = false
      state.lastError = null
      const relay = state.relay
      state.relay = null
      state.applied = []
      if (relay) await relay.close()
      await apply()
      log("disabled")
      return statusText()
    }

    async function control(action) {
      if (action === "on") return await enable()
      if (action === "off") return await disable()
      if (action === "status") return statusText()
      return "Использование: /proxy on | /proxy off | /proxy status"
    }

    function statusText() {
      const lines = []
      lines.push(`Proxy Router: ${state.enabled ? "ВКЛ" : "ВЫКЛ"}`)

      if (proxy) lines.push(`Прокси: ${redactProxy(options.proxy)}`)
      else lines.push(`Прокси: не задан (${configError ?? "option \"proxy\""})`)

      if (configError) lines.push(`Конфигурация: ${configError}`)

      lines.push(`Цели: ${targets.length > 0 ? targets.join(", ") : "—"}`)

      if (state.relay) {
        lines.push(`Релей: ${state.relay.url}`)
        lines.push(`Перенаправлено: ${state.applied.length > 0 ? state.applied.join(", ") : "—"}`)
      }

      if (state.skipped.length > 0) lines.push(`Пропущено: ${state.skipped.join("; ")}`)
      if (state.lastError) lines.push(`Ошибка: ${state.lastError}`)
      return lines.join("\n")
    }

    // ---------------------------------------------------------------------
    // Command and tool surface
    // ---------------------------------------------------------------------

    const registrations = [registration]

    try {
      registrations.push(
        await ctx.command.transform((editor) => {
          editor.add({
            name: "proxy",
            description: "Локальный reverse-proxy: /proxy on | off | status",
            execute: async ({ sessionID, prompt }) => {
              const action = parseAction(prompt?.text)
              let text
              try {
                text = await enqueue(() => control(action))
              } catch (error) {
                state.lastError = error.message
                text = `Proxy Router: ошибка — ${error.message}`
              }
              await ctx.session.synthetic({ sessionID, text })
            },
          })
        }),
      )
    } catch (error) {
      log(`could not register /proxy: ${error.message}`)
    }

    try {
      registrations.push(
        await ctx.tool.transform((editor) => {
          editor.add({
            name: "proxy_router",
            description:
              "Включает, выключает или показывает состояние локального reverse-proxy, через который ходят выбранные модели.",
            input: {
              type: "object",
              properties: {
                action: {
                  type: "string",
                  enum: ["on", "off", "status"],
                  description: "on — включить релей, off — выключить, status — показать состояние",
                },
              },
              required: [],
              additionalProperties: false,
            },
            execute: async (input) => {
              const action = parseAction(input?.action ?? "status")
              try {
                return { content: await enqueue(() => control(action)) }
              } catch (error) {
                state.lastError = error.message
                return { content: `Proxy Router: ошибка — ${error.message}` }
              }
            },
          })
        }),
      )
    } catch (error) {
      log(`could not register proxy_router tool: ${error.message}`)
    }

    // ---------------------------------------------------------------------
    // Start
    // ---------------------------------------------------------------------

    if (options.enabled !== false && !configError) {
      try {
        await enqueue(enable)
      } catch (error) {
        state.lastError = error.message
        log(`could not start: ${error.message}`)
      }
    } else if (options.enabled !== false && configError) {
      log("not started: fix the options and use /proxy on")
    }

    return async () => {
      state.enabled = false
      const relay = state.relay
      state.relay = null
      if (relay) await relay.close()
      for (const item of registrations) {
        try {
          await item.dispose()
        } catch {
          // Ignore dispose failures during unload.
        }
      }
    }
  },
}
