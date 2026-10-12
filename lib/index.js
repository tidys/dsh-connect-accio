/**
 * dsh-connect-accio — expose the locally signed-in Accio account to DSH.
 *
 * Architecture, mirroring how DSH's other local-model connectors work:
 *
 *   DSH PiAiAdapter  ->  loopback shim (OpenAI wire)  ->  AccioClient  ->  Accio
 *
 * Nothing here re-implements authentication against Accio's servers: the plugin
 * reads the credentials Accio already stores on this machine, decrypts them with
 * the current Windows user's DPAPI key, and signs requests with Accio's own
 * SecurityGuard addon.
 *
 * Every request the plugin makes is a normal chat request billed to whatever
 * account Accio is signed in as. The only reads that do not consume credits are
 * the model catalog, the account/credit queries, and the token refresh.
 */
import z from '@deepseek-ai/schemastery'

import { AccioClient } from './gateway.js'
import { createAccioAdapter, ACCIO_PROVIDER, ACCIO_DISPLAY_NAME } from './adapter.js'
import { createAccioShim } from './shim.js'
import { resolveConfigRoot, resolveUserDataDir, describePaths } from './paths.js'
import { fetchCreditOverview } from './credits.js'

export const name = 'dsh-connect-accio'
export const inject = ['llm']

const CONFIG_NS = 'accio'

/** Plugin-owned route the settings card reads account + credit data from. */
export const ACCIO_CREDITS_PATH = '/plugins/dsh-connect-accio/credits'

/**
 * A catalog entry is only advisory here: discovery is live, so a saved list is
 * a cache for offline startups rather than a source of truth.
 */
const ModelConfig = z.object({
  id: z.string(),
  name: z.string().default(''),
  contextWindow: z.number().step(1).min(1),
  multimodal: z.boolean().default(false),
})

export const Config = z.object({
  userDataDir: z.string().description('Accio 的 Electron 用户数据目录；留空则自动探测（默认 %APPDATA%\\Accio）'),
  configRoot: z.string().description('Accio 的配置根目录；留空则自动探测（默认 ~/.accio）'),
  securityGuardDir: z.string().description('security_guard.node 所在目录；留空则自动探测（含注册表读取）'),
  enabled: z.boolean().default(true).description('是否启用 Accio provider'),
  lastCatalog: z.array(ModelConfig).default([]).description('上次发现的模型目录（离线回退用）'),
})

/** The namespace the host actually serves this plugin under. */
function settingsNamespaceOf(ctx) {
  const id = ctx?.fiber?.entry?.options?.id
  return typeof id === 'string' && id !== '' ? id : CONFIG_NS
}

export function apply(ctx, config) {
  const settingsNs = settingsNamespaceOf(ctx)
  const current = () => config

  if (current().enabled === false) {
    ctx.logger?.info('dsh-connect-accio: disabled by configuration')
    return
  }

  const userDataDir = resolveUserDataDir(current().userDataDir)
  const configRoot = resolveConfigRoot(current().configRoot)
  const paths = describePaths(userDataDir, configRoot)
  ctx.logger?.info('dsh-connect-accio: credential paths', paths)

  const client = new AccioClient({
    userDataDir,
    configRoot,
    securityGuardDir: current().securityGuardDir,
    onCredentials: (next) => {
      // Refresh rotates the refresh token; the on-disk store is Accio's, so the
      // rotated copy is kept in memory only. Losing it costs a re-read, never a
      // broken session, which is the right trade for not writing to an app's
      // private credential file behind its back.
      ctx.logger?.debug?.('dsh-connect-accio: access token refreshed', {
        expiresAt: next.expiresAt,
      })
    },
  })

  /** Live catalog with the saved list as an offline fallback. */
  const catalog = {
    models: Array.isArray(current().lastCatalog) ? current().lastCatalog : [],
    current() {
      return this.models
    },
    set(next) {
      this.models = next
    },
  }

  let shim
  let registration
  let adapter

  void (async () => {
    try {
      shim = createAccioShim({
        client,
        catalog: () => catalog.current(),
        logger: ctx.logger,
      })
      await shim.ready
    } catch (error) {
      ctx.logger?.error('dsh-connect-accio: loopback shim failed; provider not registered', error)
      return
    }

    const stack = createAccioAdapter({
      shim,
      catalog,
      provider: ACCIO_PROVIDER,
      displayName: ACCIO_DISPLAY_NAME,
    })
    adapter = stack
    registration = ctx.llm.registerAdapter([ACCIO_PROVIDER], stack.adapter)

    ctx.llm.registerModelDiscovery(settingsNs, async (request) => {
      if (request?.provider !== undefined && request.provider !== ACCIO_PROVIDER) return []
      try {
        const models = await client.catalog()
        catalog.set(models)
        return models.map((m) => ({
          id: m.id,
          name: m.name,
          ...(m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow }),
          inputModalities: m.multimodal === true ? ['text', 'image'] : ['text'],
        }))
      } catch (error) {
        ctx.logger?.warn('dsh-connect-accio: live model directory unavailable; serving the saved catalog', error)
        return catalog.current().map((m) => ({
          id: m.id,
          name: m.name || m.id,
          ...(m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow }),
        }))
      }
    })

    ctx.llm.registerConfigurableProviders([{
      provider: ACCIO_PROVIDER,
      displayName: ACCIO_DISPLAY_NAME,
      settingsNs,
      settingsPath: [],
      declared: false,
    }])

    registerCreditsRoute(ctx, client)

    // Warm the catalog so the model picker is populated before the first turn.
    void (async () => {
      try {
        const models = await client.catalog()
        catalog.set(models)
        adapter?.invalidate()
        ctx.logger?.info(`dsh-connect-accio: ${models.length} models discovered`)
      } catch (error) {
        ctx.logger?.warn('dsh-connect-accio: initial model discovery failed', error)
      }
    })()

    ctx.effect(() => () => {
      registration?.()
      shim?.close().catch(() => {})
    })
  })().catch((error) => {
    ctx.logger?.error('dsh-connect-accio: setup failed', error)
  })
}

export { AccioClient, createAccioShim, createAccioAdapter, resolveUserDataDir, resolveConfigRoot }

// ---------------------------------------------------------------------------
// Credit route
// ---------------------------------------------------------------------------

/** Answer one JSON response. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * Whether a request came from this machine.
 *
 * The settings card runs in the browser, so a request from a served page carries
 * a loopback Origin; a bare loopback tool call carries none. Anything else is
 * refused — this route reads the user's account data and must not be reachable
 * from a page the user happens to have open.
 */
function loopbackOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    const { hostname } = new URL(origin)
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
  } catch {
    return false
  }
}

/**
 * Mount the read-only account/credit route the settings card consumes.
 *
 * The card cannot call Accio itself: the credentials, the DPAPI unwrap and the
 * SecurityGuard signing all live in this process. So the card asks here and this
 * handler does the work.
 *
 * `ctx.inject(['webServer'], …)` is the HOST-side way to reach a service: it
 * waits for the service and hands back a context carrying it. The browser client
 * spells service lookup `ctx.get(name)`, which is what this used — and on the
 * host that resolves to nothing, so the route silently never registered and the
 * card answered 404. Every upstream call here is a read; none consumes credits.
 */
function registerCreditsRoute(ctx, client) {
  try {
    ctx.inject(['webServer'], (webCtx) => {
      const webServer = webCtx.webServer
      if (webServer?.register === undefined) {
        ctx.logger?.info('dsh-connect-accio: webServer exposes no register(); the card will show no account data')
        return
      }
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: ACCIO_CREDITS_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
          if (!loopbackOrigin(req)) return writeJson(res, 403, { error: 'origin-not-trusted' })
          try {
            await client.refreshIfNeeded()
            const overview = await fetchCreditOverview(client.credentials.accessToken)
            writeJson(res, 200, overview)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            // 401 here means the stored sign-in is no longer usable; the card
            // renders that as "signed out" rather than as a broken plugin.
            const status = /not signed in|NOT_LOGIN|401/.test(message) ? 401 : 500
            writeJson(res, status, { error: message })
          }
        },
      }))
      ctx.logger?.info(`dsh-connect-accio: credit route mounted at ${ACCIO_CREDITS_PATH}`)
    })
  } catch (error) {
    ctx.logger?.warn('dsh-connect-accio: credit route registration failed', error)
  }
}