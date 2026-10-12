/**
 * Accio account and credit queries.
 *
 * Every endpoint here is a GET with `accessToken` as a QUERY parameter — that is
 * how the desktop app calls them (`xp()` puts params in the query for a GET),
 * and a bare GET without the token is rejected with `400 Bad Request`. All of
 * these are read-only and consume no credits.
 *
 *   /api/auth/userinfo                        account identity
 *   /api/entitlement/currentSubscription      the credits panel's data source
 *   /api/entitlement/quota                    usage percent + daily reset timer
 *   /api/entitlement/listUserMessageBill      per-message usage
 *   /api/entitlement/listGrantRecords         how each credit batch was granted
 *   /api/entitlement/queryCreditUsageTrend    usage by day
 *   /api/entitlement/queryBillingHistory      paid billing history
 *
 * There is NO check-in endpoint. The desktop bundle contains no check-in path or
 * wording anywhere, and 15 plausible spellings all return 404. Daily credits are
 * granted by the server automatically as a `DAILY_REWARD` grant record
 * ("Daily refresh credits") that expires the next day — a scheduled refresh, not
 * a user action. So the card reports that rather than offering a button that
 * cannot work.
 */
import { GATEWAY_BASE } from './gateway.js'

/** Query the gateway; the token travels in the query string, as the app does. */
async function getJson(path, token, params = {}) {
  const search = new URLSearchParams({ accessToken: token, ...params })
  const res = await fetch(`${GATEWAY_BASE}${path}?${search.toString()}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  })
  return unwrap(path, res, await res.text())
}

/**
 * POST with the token in the BODY.
 *
 * `userinfo` is method-sensitive: the entitlement endpoints are GETs, but this
 * one answers `405 Method Not Allowed` to a GET and expects the token as a body
 * field. Both conventions are used by the same app, so the transport is chosen
 * per endpoint rather than assumed.
 */
async function postJson(path, token, body = {}) {
  const res = await fetch(`${GATEWAY_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ accessToken: token, ...body }),
    signal: AbortSignal.timeout(20_000),
  })
  return unwrap(path, res, await res.text())
}

/** Validate the envelope both transports share, and return `data`. */
function unwrap(path, res, text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`accio: ${path} returned non-JSON (HTTP ${res.status})`)
  }
  if (body?.success !== true) {
    const code = body?.code ?? res.status
    if (String(code) === '401' || String(code) === '403') {
      throw new Error(`accio: not signed in (${code} ${body?.message ?? ''})`.trim())
    }
    throw new Error(`accio: ${path} failed (${code} ${body?.message ?? ''})`.trim())
  }
  return body.data
}

/** Account identity, including the plan tier. */
export async function fetchUserInfo(token) {
  const data = await postJson('/api/auth/userinfo', token)
  return {
    userId: data?.userId ?? '',
    accioId: data?.accioId ?? '',
    name: data?.userName ?? '',
    email: data?.email ?? data?.desensitizedEmail ?? '',
    maskedMobile: data?.maskedMobile ?? '',
    mobileBound: data?.mobileBound === true,
    userLevel: data?.userLevel ?? '',
    routeRegion: data?.routeRegion ?? '',
    activeTeam: data?.activeTeam ?? null,
  }
}

/** Milliseconds until the daily allowance refreshes, or undefined. */
export async function fetchQuota(token) {
  try {
    const data = await getJson('/api/entitlement/quota', token)
    return {
      usagePercent: typeof data?.usagePercent === 'number' ? data.usagePercent : undefined,
      refreshCountdownSeconds: typeof data?.refreshCountdownSeconds === 'number' ? data.refreshCountdownSeconds : undefined,
    }
  } catch {
    // The panel works without this; it only adds the reset countdown.
    return {}
  }
}

/** The credit buckets the panel shows: daily, plan, add-on, referral. */
export async function fetchSubscription(token) {
  const data = await getJson('/api/entitlement/currentSubscription', token)
  const e = data?.entitlement ?? {}
  const bucket = (b) => (b === undefined || b === null ? undefined : {
    plan: b.plan ?? '',
    total: numberOrZero(b.total),
    used: numberOrZero(b.used),
    remaining: numberOrZero(b.remaining),
    refreshDate: b.refreshDate ?? null,
    nextBillingDate: b.nextBillingDate ?? null,
    expiringSoon: b.expiringSoon ?? null,
  })
  return {
    type: data?.type ?? '',
    hasQuotaPlan: data?.hasQuotaPlan === true,
    total: numberOrZero(data?.total),
    remaining: numberOrZero(data?.remaining),
    amount: data?.amount ?? '',
    currency: data?.currency ?? '',
    planName: data?.planName ?? null,
    startDate: data?.startDate ?? null,
    endDate: data?.endDate ?? null,
    daily: bucket(e.daily),
    monthly: bucket(e.monthly),
    referral: bucket(e.referral),
  }
}

/** Recent per-message usage, newest first. */
export async function fetchUsage(token, { page = 1, pageSize = 20 } = {}) {
  const data = await getJson('/api/entitlement/listUserMessageBill', token, {
    currentPage: String(page),
    pageSize: String(pageSize),
  })
  return {
    total: numberOrZero(data?.total),
    items: (data?.dataList ?? []).map((row) => ({
      at: numberOrZero(row.billDate),
      model: row.modelDisplayNameCn ?? row.modelDisplayName ?? row.modelName ?? '',
      scene: row.useScene ?? '',
      consumed: Number.parseFloat(row.consumedCredit ?? '0') || 0,
      refunded: row.refoundCredit === null || row.refoundCredit === undefined
        ? 0
        : Number.parseFloat(row.refoundCredit) || 0,
    })),
  }
}

/** How each credit batch arrived, with expiry — this is the "奖励明细". */
export async function fetchGrants(token) {
  const data = await getJson('/api/entitlement/listGrantRecords', token)
  const list = data?.records?.list ?? data?.list ?? []
  return list.map((g) => ({
    id: g.id,
    source: g.source ?? '',
    sourceName: (g.sourceName ?? '').trim(),
    type: g.type ?? '',
    amount: numberOrZero(g.creditAmount),
    grantedAt: numberOrZero(g.effectiveTimestamp),
    expiresAt: numberOrZero(g.expiryTimestamp),
    reason: g.grantReason ?? '',
  }))
}

/** Usage per day, oldest first. */
export async function fetchTrend(token) {
  const data = await getJson('/api/entitlement/queryCreditUsageTrend', token)
  return (Array.isArray(data) ? data : []).map((row) => ({
    date: row.date ?? '',
    amount: numberOrZero(row.creditAmount),
  }))
}

function numberOrZero(value) {
  const n = typeof value === 'number' ? value : Number.parseFloat(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * Everything the card needs, in one call.
 *
 * Individual detail queries are allowed to fail without collapsing the summary:
 * a signed-in account can always show its balance even if, say, the usage trend
 * endpoint is having a bad day. Only the subscription call is required.
 */
export async function fetchCreditOverview(token) {
  const [user, subscription, quota] = await Promise.all([
    fetchUserInfo(token).catch(() => undefined),
    fetchSubscription(token),
    fetchQuota(token),
  ])
  const [grants, usage, trend] = await Promise.all([
    fetchGrants(token).catch(() => []),
    fetchUsage(token).catch(() => ({ total: 0, items: [] })),
    fetchTrend(token).catch(() => []),
  ])
  return {
    fetchedAt: Date.now(),
    user,
    subscription,
    quota,
    grants,
    usage,
    trend,
    // Stated explicitly so the UI never implies a claim button that cannot work.
    checkin: {
      supported: false,
      reason: '每日积分由服务端自动发放（DAILY_REWARD），Accio 未提供签到接口',
    },
  }
}
