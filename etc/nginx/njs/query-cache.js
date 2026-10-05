import crypto from 'crypto'

const PREFIX = 'X-Wotstat-Query-Cache-'
const MAX_TTL = 31 * 24 * 60 * 60

function parameters(uri) {
  const query = uri.indexOf('?')
  if (query === -1) return []
  const decode = value => decodeURIComponent(value.replace(/\+/g, ' '))
  return uri.slice(query + 1).split('&').filter(Boolean).map(pair => {
    const separator = pair.indexOf('=')
    return separator === -1 ? [decode(pair), ''] : [decode(pair.slice(0, separator)), decode(pair.slice(separator + 1))]
  })
}

// This cheap check runs before cache lookup. No body reading or SHA-256 on HIT.
function policy(r) {
  if (r.method !== 'POST' || (r.uri !== '/' && r.uri !== '/api/db/')) return null
  // Shared cache is deliberately limited to the frontend's public read-only account.
  if (r.headersIn.Authorization !== 'Basic cHVibGljOg==' || r.headersIn.Cookie
    || r.rawHeadersIn.some(([name]) => name.toLowerCase().startsWith('x-clickhouse-'))) return null

  const key = r.headersIn[PREFIX + 'Key']
  const ttl = r.headersIn[PREFIX + 'TTL']
  const until = r.headersIn[PREFIX + 'Until']
  if (!/^v1:[0-9a-f]{64}$/.test(key || '') || (!!ttl === !!until)) return null

  const params = parameters(r.variables.request_uri)
  // The browser SDK sends unique parameter names. With duplicate settings,
  // sorting values for the hash could hide a meaningful change of their order.
  if (new Set(params.map(([key]) => key)).size !== params.length) return null
  if (params.some(([key]) => ['user', 'password', 'session_id', 'session_check'].includes(key))) return null
  // Otherwise ClickHouse can return HTTP 200 before a query eventually fails.
  const wait = params.filter(([key]) => key === 'wait_end_of_query')
  if (wait.length !== 1 || wait[0][1] !== '1') return null
  if (params.some(([key, value]) => key === 'send_progress_in_http_headers' && value !== '0')) return null

  const now = Math.floor(Date.now() / 1000)
  if (ttl) {
    if (!/^[1-9][0-9]*$/.test(ttl) || Number(ttl) > MAX_TTL) return null
    return { key, identity: ['ttl', ttl], expires: now + Number(ttl), params }
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(until)) return null
  const date = new Date(until)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== until) return null
  const expires = Math.floor(date.getTime() / 1000)
  if (expires <= now || expires - now > MAX_TTL) return null
  return { key, identity: ['until', until], expires, params }
}

function bypass(r) {
  try { return policy(r) ? '0' : '1' } catch (_) { return '1' }
}

// Only the Unix-socket server uses this content handler, after a cache miss/bypass.
function verify(r) {
  let cache
  try { cache = policy(r) } catch (_) { cache = null }
  if (!cache) {
    r.internalRedirect('@query_origin')
    return
  }

  try {
    const bytes = r.requestBuffer
    if (!bytes) throw new Error('Request body is unavailable')

    const body = bytes.toString('utf8')
    if (!Buffer.from(body, 'utf8').equals(bytes)) throw new Error('Request body must be UTF-8')

    const params = cache.params.filter(([key]) => key !== 'query_id' && key !== 'query_cache_ttl')
      .sort(([ak, av], [bk, bv]) => ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0)

    const canonical = JSON.stringify([
      'wotstat-query-cache-v1', 'POST', 'wotstat-clickhouse', params,
      r.headersIn.Authorization || '', cache.identity, body,
    ])

    const key = 'v1:' + crypto.createHash('sha256').update(canonical).digest('hex')
    if (key !== cache.key) {
      r.return(400, 'Query cache key does not match the request\n')
      return
    }

    r.variables.wotstat_query_expires = String(cache.expires)
    r.internalRedirect('@query_origin')
  } catch (error) {
    r.error('Query cache validation failed: ' + error.message)
    r.return(400, 'Unable to validate query cache key\n')
  }
}

function appendHeader(r, name, values) {
  const current = String(r.headersOut[name] || '').split(',').map(value => value.trim()).filter(Boolean)
  for (const value of values) {
    if (!current.some(item => item.toLowerCase() === value.toLowerCase())) current.push(value)
  }
  r.headersOut[name] = current.join(', ')
}

// This response becomes the upstream response of the public cache location.
// Setting X-Accel-Expires in that location's own header filter would be too late.
function prepareFill(r) {
  r.headersOut['X-Accel-Expires'] = '0'
  r.headersOut[PREFIX + 'Verified'] = '0'
  delete r.headersOut[PREFIX + 'Created']
  delete r.headersOut[PREFIX + 'Expires']

  let expires = Number(r.variables.wotstat_query_expires)
  const now = Math.floor(Date.now() / 1000)
  const control = String(r.headersOut['Cache-Control'] || '')
  if (!expires || r.status !== 200 || r.headersOut['X-ClickHouse-Exception-Code']
    || r.headersOut['Set-Cookie'] || /\b(no-store|no-cache|private)\b/i.test(control)) return

  const age = Math.max(0, Number(r.headersOut.Age) || 0)
  const maxAge = control.match(/\bs-maxage\s*=\s*"?(\d+)/i) || control.match(/\bmax-age\s*=\s*"?(\d+)/i)
  if (maxAge) expires = Math.min(expires, now + Math.max(0, Number(maxAge[1]) - age))

  const upstreamExpiry = Date.parse(String(r.headersOut.Expires || ''))
  if (Number.isFinite(upstreamExpiry)) expires = Math.min(expires, Math.floor(upstreamExpiry / 1000))
  if (expires <= now) return

  r.headersOut['X-Accel-Expires'] = '@' + expires
  r.headersOut[PREFIX + 'Verified'] = '1'
  r.headersOut[PREFIX + 'Created'] = String(now)
  r.headersOut[PREFIX + 'Expires'] = String(expires)
  r.headersOut['Cache-Control'] = 'public, max-age=' + (expires - now)
  r.headersOut.Expires = new Date(expires * 1000).toUTCString()
  r.headersOut.Age = '0'

  const vary = String(r.headersOut.Vary || '').split(',').map(value => value.trim())
    .filter(value => value && value.toLowerCase() !== 'accept-encoding')

  if (vary.length) r.headersOut.Vary = vary.join(', ')
  else delete r.headersOut.Vary
}

function responseHeaders(r) {
  const state = r.variables.upstream_cache_status
  const verified = r.variables.upstream_http_x_wotstat_query_cache_verified === '1'
  const status = state === 'HIT' ? 'HIT' : state !== 'BYPASS' && verified ? 'MISS' : 'BYPASS'
  r.headersOut[PREFIX + 'Status'] = status
  r.headersOut['X-Cache-Status'] = status
  const upstreamStatus = r.variables.upstream_http_x_wotstat_query_cache_status

  // A cached upstream status describes an older fill, not an upstream call now.
  if (state !== 'HIT' && /^(HIT|MISS|BYPASS)$/.test(upstreamStatus || '')) {
    r.headersOut[PREFIX + 'Upstream-Status'] = upstreamStatus
  } else {
    delete r.headersOut[PREFIX + 'Upstream-Status']
  }

  // CORS must also work for cached responses first requested without Origin,
  // and for errors generated locally (including a rejected hash).
  r.headersOut['Access-Control-Allow-Origin'] = '*'
  appendHeader(r, 'Access-Control-Expose-Headers', ['Age', 'Date', PREFIX + 'Status', PREFIX + 'Upstream-Status', 'X-Cache-Status'])
  appendHeader(r, 'Vary', ['Accept-Encoding'])

  if (verified) {
    const created = Number(r.variables.upstream_http_x_wotstat_query_cache_created)
    r.headersOut.Age = String(Math.max(0, Math.floor(Date.now() / 1000) - created))
  }
}

export default { bypass, verify, prepareFill, responseHeaders }
