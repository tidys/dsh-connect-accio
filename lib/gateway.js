/**
 * The Accio LLM gateway client.
 *
 * Wire protocol, all of it established against the live service:
 *
 *   POST https://phoenix-gw.alibaba.com/api/adk/llm/generateContent?sg_k=<md5(requestId)>
 *     headers: utdid, version, appKey:'OneChat', + SecurityGuard's pctb-x-* set
 *     body   : Gemini-style envelope, keys converted camelCase -> snake_case
 *
 * Four requirements are non-obvious and each one produced a misleading error
 * when missed:
 *
 *   - `empid`, `tenant` and `iai_tag` must be EMPTY STRINGS. Sending real values
 *     yields `402 unauthorized`.
 *   - `message_id` is required; without it every request is `400 invalid params`.
 *   - the `appKey: 'OneChat'` header is what clears the server-side version
 *     gate. `version` alone is not enough, and the gate is not about actually
 *     being out of date.
 *   - the RESPONSE is snake_case (`function_call`, `args_json`,
 *     `usage_metadata`) even though the request is camelCase. Reading the
 *     camelCase names silently yields zero tool calls.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadCredentials } from './oscrypt.js'
import { securityHeaders } from './security-guard.js'

export const APP_KEY = 'OneChat'
export const APP_VERSION = '0.34.3'
export const GATEWAY_BASE = 'https://phoenix-gw.alibaba.com'
const LLM_PATH = '/api/adk/llm/generateContent'
const CATALOG_PATH = '/api/llm/config/v2'
const REFRESH_PATH = '/api/auth/refresh_token'

/** camelCase -> snake_case, recursively, exactly as Accio's `Vn()` does. */
export function toSnake(value) {
  if (Array.isArray(value)) return value.map(toSnake)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue
      out[k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = toSnake(v)
    }
    return out
  }
  return value
}

export const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex')

/**
 * A chat completion, streamed from Accio.
 *
 * `chatStream` yields protocol events (`text`, `reasoning`, `toolCall`, `usage`)
 * so the shim can translate them to OpenAI SSE without a second parse.
 */
export class AccioClient {
  /**
   * @param options.userDataDir - Electron user-data dir holding credentials.enc.
   * @param options.configRoot - app config root holding `utdid`.
   * @param options.securityGuardDir - explicit security_guard.node path/dir.
   * @param options.onCredentials - called when a refresh rotates credentials.
   */
  constructor(options = {}) {
    this.userDataDir = options.userDataDir
    this.configRoot = options.configRoot
    this.securityGuardDir = options.securityGuardDir
    this.onCredentials = options.onCredentials
    this.credentials = undefined
    this.utdid = undefined
    this.inflight = undefined
  }

  /** Load credentials and the device id once, on first use. */
  async ready() {
    if (this.credentials === undefined) {
      this.credentials = await loadCredentials(this.userDataDir)
    }
    if (this.utdid === undefined) {
      this.utdid = readFileSync(join(this.configRoot, 'utdid'), 'utf8').trim()
    }
    return this
  }

  /** Drop cached credentials so the next call re-reads the encrypted store. */
  invalidate() {
    this.credentials = undefined
    this.utdid = undefined
    this.inflight = undefined
  }

  /**
   * Refresh the access token when it is close to expiry.
   *
   * The access token is an opaque 32-character string, NOT a JWT, so its
   * lifetime cannot be read from the token itself — `expiresAt` is the only
   * source of truth. Refresh ROTATES the refresh token, so concurrent callers
   * are collapsed through a single in-flight promise; two parallel refreshes
   * would invalidate each other.
   */
  async refreshIfNeeded(marginMs = 120_000) {
    await this.ready()
    const c = this.credentials
    if (typeof c?.expiresAt === 'number' && c.expiresAt > Date.now() + marginMs) return c
    this.inflight ??= this.#refresh().finally(() => { this.inflight = undefined })
    return this.inflight
  }

  async #refresh() {
    const c = this.credentials
    const res = await fetch(`${GATEWAY_BASE}${REFRESH_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: c.accessToken, refreshToken: c.refreshToken }),
    })
    const body = await res.json().catch(() => undefined)
    if (body?.success !== true || body.data === null || body.data === undefined) {
      throw new Error(`accio: token refresh failed (${body?.code ?? res.status} ${body?.message ?? 'no message'})`)
    }
    const next = { ...c, ...body.data }
    this.credentials = next
    // Persisting is the host's business: this callback lets the plugin write the
    // rotated token to its own store without this module owning that policy.
    this.onCredentials?.(next)
    return next
  }

  /** Signed headers for one request. */
  #headers(fullUrl) {
    return {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      utdid: this.utdid,
      version: APP_VERSION,
      appKey: APP_KEY,
      ...securityHeaders(fullUrl, this.securityGuardDir),
    }
  }

  /**
   * Fetch the account's model catalog.
   *
   * Read-only and does not consume credits. The endpoint genuinely verifies the
   * token: a valid one returns the catalog, a bogus one returns
   * `403 auth failed`.
   */
  async catalog() {
    await this.refreshIfNeeded()
    const res = await fetch(`${GATEWAY_BASE}${CATALOG_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ token: this.credentials.accessToken }),
    })
    const text = await res.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`accio: model catalog was not JSON (${res.status})`)
    }
    if (parsed?.success !== true) {
      throw new Error(`accio: model catalog rejected (${parsed?.code ?? res.status} ${parsed?.message ?? ''})`.trim())
    }
    const groups = Array.isArray(parsed.data) ? parsed.data : []
    const models = []
    for (const group of groups) {
      for (const m of group.modelList ?? []) {
        if (m.visible !== true) continue
        models.push({
          id: m.modelCode,
          name: m.modelDisplayName || m.modelName || m.modelCode,
          provider: group.provider,
          contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : undefined,
          multimodal: m.multimodal === true,
          reasoningEfforts: Array.isArray(m.reasoningEfforts) ? m.reasoningEfforts : [],
          defaultReasoningEffort: m.defaultReasoningEffort ?? undefined,
          multiple: typeof m.effectiveMultiple === 'number' ? m.effectiveMultiple : undefined,
          free: m.freeUse === true,
        })
      }
    }
    // Cheapest first. Accio returns models grouped by vendor, which buries the
    // price signal: the picker is where a user decides what a turn will cost,
    // and ascending multiplier is the ordering that makes that comparison
    // possible. Unpriced rows sort last rather than first, so a model whose
    // multiplier is missing never masquerades as a bargain. The sort is stable,
    // so equal-multiplier rows keep the vendor's own relative order.
    models.sort((a, b) => {
      const ai = typeof a.multiple === 'number'
      const bi = typeof b.multiple === 'number'
      if (ai !== bi) return ai ? -1 : 1
      if (!ai) return 0
      return a.multiple - b.multiple
    })
    return models
  }

  /**
   * One streaming turn.
   *
   * @param request.model - the `modelCode` from the catalog.
   * @param request.messages - OpenAI-style messages from the shim.
   * @param request.tools - OpenAI-style tool definitions.
   * @param request.systemInstruction - system text, sent separately.
   * @param request.signal - abort signal.
   * @yields protocol events.
   */
  async *chatStream(request) {
    await this.refreshIfNeeded()
    const requestId = `req-${Date.now()}`
    const body = toSnake({
      model: request.model,
      // These three MUST be empty strings: real values are rejected as 402.
      empid: '',
      tenant: '',
      iaiTag: '',
      requestId,
      userRequestId: requestId,
      contents: request.contents,
      systemInstruction: request.systemInstruction || undefined,
      tools: request.tools?.length ? request.tools : undefined,
      temperature: request.temperature,
      maxOutputTokens: request.maxOutputTokens,
      stopSequences: [],
      properties: {
        utdid: this.utdid,
        version: APP_VERSION,
        appKey: APP_KEY,
        normalized_response: 'true',
      },
      token: this.credentials.accessToken,
      // Required. Omitting it is a hard 400 regardless of everything else.
      messageId: md5(requestId + Math.random()),
      incremental: true,
    })

    const fullUrl = `${GATEWAY_BASE}${LLM_PATH}?sg_k=${md5(requestId)}`
    const res = await fetch(fullUrl, {
      method: 'POST',
      headers: this.#headers(fullUrl),
      body: JSON.stringify(body),
      signal: request.signal ?? AbortSignal.timeout(300_000),
    })

    if (!res.ok) {
      throw new Error(`accio: gateway HTTP ${res.status} ${res.statusText}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    // A function call arrives in pieces and must be merged by id: the first
    // frame carries {id,name}, a later one adds argsJson.
    const calls = new Map()

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split(/\r?\n/)
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '') continue
          let ev
          try {
            ev = JSON.parse(payload)
          } catch {
            continue
          }
          if (ev.error_code !== undefined && ev.error_code !== '200') {
            throw new Error(`accio: gateway error ${ev.error_code} ${ev.error_message ?? ''}`.trim())
          }
          for (const part of ev.content?.parts ?? []) {
            if (typeof part.text === 'string') {
              // `thought: true` marks chain-of-thought; it is not the answer and
              // must not be rendered as one.
              if (part.thought === true) yield { type: 'reasoning', text: part.text }
              else if (part.text !== '') yield { type: 'text', text: part.text }
            }
            // snake_case on the way back, unlike the camelCase request.
            const fc = part.function_call
            if (fc !== undefined && fc !== null) {
              const prev = calls.get(fc.id) ?? { id: fc.id, name: fc.name, args: '' }
              const merged = {
                id: fc.id ?? prev.id,
                name: fc.name ?? prev.name,
                args: fc.args_json !== undefined && fc.args_json !== '' ? fc.args_json : prev.args,
              }
              calls.set(merged.id, merged)
              yield { type: 'toolCallDelta', call: { ...merged } }
            }
          }
          const usage = ev.usage_metadata ?? ev.usageMetadata
          if (usage !== undefined && usage !== null) {
            yield {
              type: 'usage',
              usage: {
                input: usage.prompt_token_count ?? usage.promptTokenCount ?? 0,
                output: usage.candidates_token_count ?? usage.candidatesTokenCount ?? 0,
                cached: usage.cached_content_token_count ?? usage.cachedContentTokenCount ?? 0,
                reasoning: usage.thoughts_token_count ?? usage.thoughtsTokenCount ?? 0,
              },
            }
          }
          if (ev.finish_reason !== undefined) yield { type: 'finish', reason: ev.finish_reason }
        }
      }
    } finally {
      reader.cancel().catch(() => {})
    }
    yield { type: 'done', toolCalls: [...calls.values()] }
  }
}
