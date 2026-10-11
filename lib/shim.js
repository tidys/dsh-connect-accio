/**
 * The loopback shim: an OpenAI-compatible `/v1/chat/completions` endpoint on
 * 127.0.0.1 that DSH's `PiAiAdapter` drives, translating to and from Accio.
 *
 * Why a shim at all: DSH's pi-ai adapter speaks the OpenAI wire format, while
 * Accio speaks a Gemini-style envelope. Rather than teach the adapter a second
 * dialect, the plugin exposes exactly the subset of the OpenAI API that the
 * adapter uses and does the translation here.
 *
 * Security: the server binds to 127.0.0.1 on an ephemeral port and demands a
 * per-process random bearer token, so nothing else on the machine can use it as
 * a free model proxy. Host and Origin are checked to be loopback for the same
 * reason — a browser page must not be able to reach it.
 */
import { createServer } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

/**
 * Identifies this shim on a machine running several connectors at once.
 *
 * Each local-model connector opens its own loopback listener, and they answer
 * unauthorized probes similarly, so "a 401 came back" does not say whose shim it
 * was. `/healthz` advertises this marker so a diagnostic can tell them apart.
 */
export const SHIM_MARKER = 'dsh-connect-accio'

/** Map a shim failure to an HTTP status the adapter will read sensibly. */
const STATUS_BY_KIND = {
  auth: 401,
  credential: 401,
  unsupported: 400,
  upstream: 502,
  transport: 502,
  internal: 500,
}

function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

function writeError(res, status, code, message) {
  writeJson(res, status, { error: { message, type: code, code } })
}

function hostIsLoopback(host) {
  if (typeof host !== 'string') return false
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
  return name === '127.0.0.1' || name === 'localhost' || name === '::1' || name === '0.0.0.0'
}

function originIsLoopback(origin) {
  if (origin === undefined) return true
  if (typeof origin !== 'string') return false
  try {
    return hostIsLoopback(new URL(origin).host)
  } catch {
    return false
  }
}

async function readBody(req, limit = 16 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * Convert an OpenAI message list into Accio `contents` plus a system string.
 *
 * Accio is Gemini-shaped: roles are `user`/`model`, tool results are `user`
 * parts carrying `functionResponse`, and the system prompt is a separate field.
 * Tool-call arguments and results are JSON **strings** on this wire
 * (`argsJson` / `responseJson`), not objects.
 */
export function toAccioContents(messages) {
  const contents = []
  const system = []

  for (const message of messages ?? []) {
    const role = message?.role
    if (role === 'system' || role === 'developer') {
      const text = typeof message.content === 'string' ? message.content : flattenText(message.content)
      if (text !== '') system.push(text)
      continue
    }

    if (role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            id: message.tool_call_id ?? '',
            name: message.name ?? '',
            responseJson: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? {}),
          },
        }],
      })
      continue
    }

    if (role === 'assistant') {
      const parts = []
      const text = typeof message.content === 'string' ? message.content : flattenText(message.content)
      if (text !== '') parts.push({ text })
      for (const call of message.tool_calls ?? []) {
        // `argsJson` must be the raw argument string, not a parsed object.
        parts.push({
          functionCall: {
            id: call.id ?? '',
            name: call.function?.name ?? '',
            argsJson: call.function?.arguments ?? '{}',
          },
        })
      }
      if (parts.length > 0) contents.push({ role: 'model', parts })
      continue
    }

    // user (and anything unrecognised, which is safest treated as user input)
    const parts = []
    if (typeof message.content === 'string') {
      if (message.content !== '') parts.push({ text: message.content })
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') parts.push({ text: block.text })
      }
    }
    if (parts.length > 0) contents.push({ role: 'user', parts })
  }

  return { contents, systemInstruction: system.join('\n\n') }
}

function flattenText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('')
}

/** Convert OpenAI tool definitions to Accio's `{name, description, parametersJson}`. */
export function toAccioTools(tools) {
  if (!Array.isArray(tools)) return undefined
  const out = []
  for (const tool of tools) {
    const fn = tool?.function
    if (fn?.name === undefined) continue
    out.push({
      name: fn.name,
      description: fn.description ?? '',
      parametersJson: JSON.stringify(fn.parameters ?? { type: 'object', properties: {} }),
    })
  }
  return out.length > 0 ? out : undefined
}

/**
 * Start the shim.
 *
 * @param options.client - an `AccioClient`.
 * @param options.catalog - () => the current model list.
 * @param options.logger - optional `{ warn, error }`.
 */
export function createAccioShim(options) {
  const secret = randomBytes(32).toString('base64url')
  const sockets = new Set()
  const server = createServer((req, res) => { handle(req, res) })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  const ready = new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  server.listen(0, '127.0.0.1')

  function bearerOk(req) {
    const header = req.headers.authorization
    const match = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null
    if (match === null) return false
    const actual = Buffer.from(match[1])
    const expected = Buffer.from(secret)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }

  async function handle(req, res) {
    try {
      if (!hostIsLoopback(req.headers.host)) return writeError(res, 403, 'host_not_allowed', 'Host must be loopback')
      if (!originIsLoopback(req.headers.origin)) return writeError(res, 403, 'origin_not_allowed', 'Origin must be loopback')
      // The marker is echoed even on the unauthorized path: a diagnostic that
      // probes an unknown port gets a 401, and the marker is what makes it
      // attributable to this plugin rather than another connector's shim.
      if (!bearerOk(req)) {
        res.setHeader('X-Dsh-Connector', SHIM_MARKER)
        return writeError(res, 401, 'unauthorized', `Missing or invalid bearer for ${SHIM_MARKER}`)
      }

      const url = req.url ?? '/'
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        return writeJson(res, 200, { ok: true, plugin: SHIM_MARKER })
      }
      if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
        const models = options.catalog()
        return writeJson(res, 200, {
          object: 'list',
          data: models.map((m) => ({ id: m.id, object: 'model', created: 0, owned_by: 'accio' })),
        })
      }
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
        return await handleChat(req, res)
      }
      return writeError(res, 404, 'not_found', `No such route: ${req.method} ${url}`)
    } catch (error) {
      options.logger?.error('dsh-connect-accio: shim request failed', error)
      if (!res.headersSent) writeError(res, 500, 'internal', 'Internal shim error')
      else if (!res.writableEnded) res.end()
    }
  }

  async function handleChat(req, res) {
    const contentType = req.headers['content-type']
    if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
      return writeError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
    }
    const raw = (await readBody(req)).toString('utf8')
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      return writeError(res, 400, 'invalid_json', 'Request body must be valid JSON')
    }

    const controller = new AbortController()
    const abort = () => controller.abort()
    req.once('aborted', abort)
    req.socket.once('close', abort)

    const { contents, systemInstruction } = toAccioContents(parsed.messages)
    const tools = toAccioTools(parsed.tools)
    const model = typeof parsed.model === 'string' ? parsed.model : ''
    const id = `chatcmpl-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)

    let started = false
    try {
      for await (const ev of options.client.chatStream({
        model,
        contents,
        systemInstruction,
        tools,
        temperature: typeof parsed.temperature === 'number' ? parsed.temperature : undefined,
        maxOutputTokens: typeof parsed.max_tokens === 'number' ? parsed.max_tokens : undefined,
        signal: controller.signal,
      })) {
        if (ev.type === 'done') {
          const calls = ev.toolCalls ?? []
          if (!started) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
              'X-Accel-Buffering': 'no',
            })
            started = true
          }
          if (calls.length > 0) {
            // Emit the accumulated tool calls once, complete, so the adapter
            // never has to reassemble fragments itself.
            writeSse(res, {
              id, object: 'chat.completion.chunk', created, model,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: calls.map((c, i) => ({
                    index: i,
                    id: c.id,
                    type: 'function',
                    function: { name: c.name, arguments: c.args },
                  })),
                },
                finish_reason: null,
              }],
            })
          }
          writeSse(res, {
            id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: {}, finish_reason: calls.length > 0 ? 'tool_calls' : 'stop' }],
          })
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }

        if (!started) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          })
          started = true
          // OpenAI streaming opens with an assistant-role delta.
          writeSse(res, {
            id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          })
        }

        if (ev.type === 'text') {
          writeSse(res, {
            id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { content: ev.text }, finish_reason: null }],
          })
        } else if (ev.type === 'reasoning') {
          // DSH reads reasoning from `reasoning_content`; the plain `content`
          // field must stay reserved for the actual answer.
          writeSse(res, {
            id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { reasoning_content: ev.text }, finish_reason: null }],
          })
        }
      }

      // The upstream stream ended without a `done` event.
      if (!started) return writeError(res, 502, 'empty_stream', 'Accio returned no events')
      res.write('data: [DONE]\n\n')
      res.end()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      options.logger?.warn('dsh-connect-accio: chat failed', message)
      if (!started) return writeError(res, 502, 'upstream', message)
      // Mid-stream failure: surface it in-band, then terminate the SSE stream.
      // HTTP 200 is already committed, so an error event is the only channel.
      writeSse(res, {
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        error: { message, type: 'upstream' },
      })
      res.write('data: [DONE]\n\n')
      res.end()
    }
  }

  function writeSse(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }

  return {
    ready,
    baseUrl() {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('accio shim is not listening')
      return `http://127.0.0.1:${address.port}`
    },
    token: () => secret,
    close: () => new Promise((resolve, reject) => {
      for (const socket of sockets) socket.destroy()
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    }),
  }
}

export { STATUS_BY_KIND }
