const PREFIX = 'X-Wotstat-Query-Cache-'
const MAX_TTL = 31 * 24 * 60 * 60
const CACHE_NAME = 'wotstat-query-cache'
const CREATED = PREFIX + 'Created'
const EXPIRES = PREFIX + 'Expires'


function policy(request, url) {
  if (request.method !== 'POST' || url.pathname !== '/api/db/') return null
  const headers = request.headers

  if (headers.get('Authorization') !== 'Basic cHVibGljOg==' || headers.get('Cookie')) return null
  if ([...headers.keys()].some(name => name.startsWith('x-clickhouse-'))) return null

  const key = headers.get(PREFIX + 'Key')
  const ttl = headers.get(PREFIX + 'TTL')
  const until = headers.get(PREFIX + 'Until')
  if (!/^v1:[0-9a-f]{64}$/.test(key || '') || (!!ttl === !!until)) return null

  // Decode as strictly as nginx: URLSearchParams would accept malformed escapes.
  const decode = value => decodeURIComponent(value.replace(/\+/g, ' '))
  const params = url.search.slice(1).split('&').filter(Boolean).map(pair => {
    const separator = pair.indexOf('=')
    if (separator === -1) return [decode(pair), '']
    return [decode(pair.slice(0, separator)), decode(pair.slice(separator + 1))]
  })

  if (new Set(params.map(([name]) => name)).size !== params.length) return null
  if (params.some(([name]) => ['user', 'password', 'session_id', 'session_check'].includes(name))) return null
  if (!params.some(([name, value]) => name === 'wait_end_of_query' && value === '1')) return null
  if (params.some(([name, value]) => name === 'send_progress_in_http_headers' && value !== '0')) return null

  const now = Math.floor(Date.now() / 1000)
  if (ttl) {
    if (!/^[1-9][0-9]*$/.test(ttl) || Number(ttl) > MAX_TTL) return null
    return { key, expires: now + Number(ttl) }
  }

  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(until)) return null

  const date = new Date(until)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== until) return null

  const expires = Math.floor(date.getTime() / 1000)
  return expires > now && expires - now <= MAX_TTL ? { key, expires } : null
}

function responseExpiry(response, requestedExpiry, now) {
  const headers = response.headers
  if (response.status !== 200 || headers.has('Set-Cookie') || headers.has('X-ClickHouse-Exception-Code')) return 0

  if (!/^(HIT|MISS)$/.test(headers.get(PREFIX + 'Status') || '')) return 0

  const control = headers.get('Cache-Control') || ''
  if (!/\bpublic\b/i.test(control) || /\b(no-store|no-cache|private)\b/i.test(control)) return 0

  const vary = (headers.get('Vary') || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
  if (vary.some(value => value !== 'accept-encoding')) return 0

  const maxAge = control.match(/\bs-maxage\s*=\s*"?(\d+)/i) || control.match(/\bmax-age\s*=\s*"?(\d+)/i)
  const expires = Date.parse(headers.get('Expires') || '') / 1000
  const age = Number(headers.get('Age') || 0)

  if (!maxAge || !Number.isFinite(expires) || !Number.isFinite(age) || age < 0) return 0
  const date = Date.parse(headers.get('Date') || '') / 1000
  const apparentAge = Number.isFinite(date) ? Math.max(0, now - date) : 0

  return Math.floor(Math.min(requestedExpiry, expires, now + Number(maxAge[1]) - Math.max(age, apparentAge)))
}

function appendHeader(headers, name, values) {
  const current = (headers.get(name) || '').split(',').map(value => value.trim()).filter(Boolean)
  for (const value of values) {
    if (!current.some(item => item.toLowerCase() === value.toLowerCase())) current.push(value)
  }
  headers.set(name, current.join(', '))
}

function clientResponse(response, status, upstreamStatus) {
  const headers = new Headers(response.headers)
  const created = Number(headers.get(CREATED))
  if (headers.has(CREATED) && Number.isFinite(created)) {
    headers.set('Age', String(Math.max(0, Math.floor(Date.now() / 1000) - created)))
  }

  headers.delete(CREATED)
  headers.delete(EXPIRES)
  headers.set(PREFIX + 'Status', status)
  headers.set('X-Cache-Status', status)
  headers.delete(PREFIX + 'Upstream-Status')

  if (/^(HIT|MISS|BYPASS)$/.test(upstreamStatus || '')) headers.set(PREFIX + 'Upstream-Status', upstreamStatus)
  appendHeader(headers, 'Vary', ['Accept-Encoding'])
  appendHeader(headers, 'Access-Control-Expose-Headers', ['Age', 'Date', PREFIX + 'Status', PREFIX + 'Upstream-Status', 'X-Cache-Status'])

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

async function originResponse(request) {
  const headers = new Headers(request.headers)
  headers.set('Accept-Encoding', 'gzip')

  return fetch(new Request(request, { headers, redirect: 'manual' }), {
    cf: { cacheTtlByStatus: { '100-599': -1 } },
  })
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    // The route ends with '*' to include query strings, but only this endpoint is cacheable.
    if (url.pathname !== '/api/db/') return fetch(request)

    let requested
    try { requested = policy(request, url) } catch { requested = null }

    let cache
    let cacheKey
    if (requested) {
      try {
        cache = await caches.open(CACHE_NAME)

        const keyUrl = new URL('/api/db/__query-cache/' + requested.key, url.origin)
        cacheKey = new Request(keyUrl, { headers: { 'Accept-Encoding': 'gzip' } })
        const cached = await cache.match(cacheKey)

        if (cached) {
          const expires = Number(cached.headers.get(EXPIRES))
          if (expires > Math.floor(Date.now() / 1000)) return clientResponse(cached, 'HIT')
          await cached.body?.cancel()
          await cache.delete(cacheKey)
        }
      } catch (error) {
        console.error('Query cache lookup failed:', error.message)
        cache = null
      }
    }

    const response = await originResponse(request)
    const upstreamStatus = response.headers.get(PREFIX + 'Status')
    const now = Math.floor(Date.now() / 1000)
    const expires = requested && cache ? responseExpiry(response, requested.expires, now) : 0
    if (expires <= now) return clientResponse(response, 'BYPASS', upstreamStatus)

    const headers = new Headers(response.headers)
    headers.set(CREATED, String(now))
    headers.set(EXPIRES, String(expires))
    headers.set('Date', new Date(now * 1000).toUTCString())
    headers.set('Expires', new Date(expires * 1000).toUTCString())
    headers.set('Cache-Control', 'public, max-age=' + (expires - now))
    headers.set('Age', '0')

    headers.delete('Vary')
    const stored = new Response(response.body, { status: response.status, statusText: response.statusText, headers })
    ctx.waitUntil(cache.put(cacheKey, stored.clone()).catch(error => {
      console.error('Query cache write failed:', error.message)
    }))

    return clientResponse(stored, 'MISS', upstreamStatus)
  },
}
