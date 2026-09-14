/**
 * Shared LinkedIn helpers — Sign In with LinkedIn (OpenID Connect) + Posts API
 *
 * Two capabilities, deliberately separable:
 *
 *   1. READ  (always on)  — scopes `openid profile email`
 *      Self-serve product: "Sign In with LinkedIn using OpenID Connect".
 *      Gives us name, email and a profile picture URL from /v2/userinfo.
 *
 *   2. WRITE (opt-in)     — adds scope `w_member_social`
 *      Self-serve product: "Share on LinkedIn". Lets us publish a native
 *      image post to the member's OWN profile. No partner review needed —
 *      partner approval only applies to company pages / posting as others.
 *      Enable with LINKEDIN_ENABLE_POSTING=true once the product is added.
 *
 * Posting is feature-flagged so the tool ships and works with read-only
 * access, then upgrades to one-click posting without a code change.
 *
 * Env vars:
 *   LINKEDIN_CLIENT_ID       required
 *   LINKEDIN_CLIENT_SECRET   required
 *   LINKEDIN_ENABLE_POSTING  optional — 'true' to request w_member_social
 *   LINKEDIN_API_VERSION     optional — YYYYMM, defaults below. LinkedIn
 *                            retires versions on a rolling basis; bump this
 *                            env var rather than editing code.
 *   JWT_SECRET               required — signs the short-lived LinkedIn cookie
 */

const AUTH_URL     = 'https://www.linkedin.com/oauth/v2/authorization'
const TOKEN_URL    = 'https://www.linkedin.com/oauth/v2/accessToken'
const USERINFO_URL = 'https://api.linkedin.com/v2/userinfo'
const REST_BASE    = 'https://api.linkedin.com/rest'

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET!)

/** Cookie holding the signed LinkedIn identity + access token. */
export const LI_COOKIE    = 'eac_li'
/** Cookie holding the OAuth CSRF state between authorize and callback. */
export const STATE_COOKIE = 'eac_li_state'

export const LINKEDIN_VERSION = process.env.LINKEDIN_API_VERSION || '202508'

export interface LinkedInUser {
  sub:      string          // LinkedIn member id — becomes urn:li:person:{sub}
  name:     string
  email:    string
  picture?: string          // short-lived CDN URL — download immediately
}

export interface LinkedInToken extends LinkedInUser {
  accessToken: string
  canPost:     boolean
}

// ── Capability flags ─────────────────────────────────────────────────────────

export function postingEnabled(): boolean {
  return process.env.LINKEDIN_ENABLE_POSTING === 'true'
}

export function linkedInConfigured(): boolean {
  return !!(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET)
}

function scopes(): string {
  const base = ['openid', 'profile', 'email']
  if (postingEnabled()) base.push('w_member_social')
  return base.join(' ')
}

// ── OAuth ────────────────────────────────────────────────────────────────────

export function authorizeUrl(state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.LINKEDIN_CLIENT_ID!,
    redirect_uri:  redirectUri,
    state,
    scope:         scopes(),
  })
  return AUTH_URL + '?' + params.toString()
}

export async function exchangeCode(code: string, redirectUri: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  redirectUri,
      client_id:     process.env.LINKEDIN_CLIENT_ID!,
      client_secret: process.env.LINKEDIN_CLIENT_SECRET!,
    }),
  })
  const json = await res.json()
  if (!res.ok || !json.access_token) {
    console.error('[linkedin] token exchange failed:', res.status, JSON.stringify(json).slice(0, 300))
    throw new Error('LinkedIn token exchange failed')
  }
  return json.access_token as string
}

export async function getUserInfo(accessToken: string): Promise<LinkedInUser> {
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: 'Bearer ' + accessToken },
  })
  const json = await res.json()
  if (!res.ok || !json.sub) {
    console.error('[linkedin] userinfo failed:', res.status, JSON.stringify(json).slice(0, 300))
    throw new Error('LinkedIn userinfo failed')
  }
  return {
    sub:     json.sub as string,
    name:    (json.name as string) || [json.given_name, json.family_name].filter(Boolean).join(' '),
    email:   (json.email as string) || '',
    picture: (json.picture as string) || undefined,
  }
}

// ── Session cookie (short-lived, signed with the shared JWT_SECRET) ──────────

export async function signLinkedInToken(user: LinkedInToken): Promise<string> {
  const { SignJWT } = await import('jose')
  return new SignJWT({ ...user })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('2h')
    .sign(JWT_SECRET)
}

export async function verifyLinkedInToken(token: string | null): Promise<LinkedInToken | null> {
  if (!token) return null
  try {
    const { jwtVerify } = await import('jose')
    const { payload } = await jwtVerify(token, JWT_SECRET)
    return {
      sub:         payload.sub         as string,
      name:        payload.name        as string,
      email:       payload.email       as string,
      picture:     payload.picture     as string | undefined,
      accessToken: payload.accessToken as string,
      canPost:     (payload.canPost    as boolean) ?? false,
    }
  } catch {
    return null
  }
}

export function parseCookie(cookieHeader: string, name: string): string | null {
  const match = cookieHeader.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'))
  return match ? decodeURIComponent(match[1]) : null
}

export function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return name + '=' + encodeURIComponent(value) +
    '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + maxAgeSeconds
}

// ── Profile photo ────────────────────────────────────────────────────────────

const MAX_PHOTO_BYTES = 4 * 1024 * 1024

export interface Photo {
  dataUrl: string
  width:   number | null
  height:  number | null
  /** Which CDN rendition we actually got bytes from, for diagnostics. */
  source:  string
}

/**
 * Read the pixel dimensions straight out of the file header.
 *
 * Dependency-free on purpose: this repo has no image library and does not need
 * one for two dozen lines. Used only to report what we fetched, never to decode.
 */
function imageSize(buf: Buffer): { width: number; height: number } | null {
  // PNG — IHDR is always the first chunk, width/height at a fixed offset.
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  // JPEG — walk the marker segments to the start-of-frame.
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2
    while (o < buf.length - 9) {
      if (buf[o] !== 0xff) { o++; continue }
      const marker = buf[o + 1]
      // SOF0-SOF15 carry the dimensions; DHT/JPG/DAC do not.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) }
      }
      o += 2 + buf.readUInt16BE(o + 2)
    }
  }
  return null
}

/**
 * LinkedIn's OIDC `picture` claim points at a small rendition — typically
 * `profile-displayphoto-shrink_100_100`. Upscaled into the badge portrait that
 * is a visibly soft ~4x blow-up.
 *
 * The CDN stores larger renditions of the same image under the same signature,
 * so swapping the size segment usually yields real pixels rather than an
 * interpolated guess. "Usually" is doing work there — LinkedIn has never
 * documented this, so every candidate is tried in turn and the original URL is
 * always the last resort. If they change it, the badge quietly goes back to
 * looking exactly as it does today rather than breaking.
 */
export function renditionCandidates(url: string): string[] {
  const sizeRe = /(profile-displayphoto-(?:shrink|scale)_)(\d+)_(\d+)/
  const m = sizeRe.exec(url)
  if (!m) return [url]

  const current = Number(m[2])
  const bigger  = [800, 400, 200].filter(s => s > current)
  return [...bigger.map(s => url.replace(sizeRe, `$1${s}_${s}`)), url]
}

async function tryFetchImage(url: string): Promise<{ buf: Buffer; type: string } | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const type = res.headers.get('content-type') || 'image/jpeg'
    if (!type.startsWith('image/')) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.byteLength || buf.byteLength > MAX_PHOTO_BYTES) return null
    return { buf, type }
  } catch {
    return null
  }
}

/**
 * Download the member's LinkedIn photo and return it as a data: URL.
 *
 * Two reasons this is server-side and not a browser fetch:
 *   1. The CDN URL is short-lived — we must grab the bytes while it is valid.
 *   2. media.licdn.com does not reliably send CORS headers, so drawing it
 *      straight into a <canvas> would taint it and break toDataURL().
 *
 * Returns null on any failure — the UI falls back to an initials monogram.
 */
export async function fetchPhotoDataUrl(url?: string): Promise<Photo | null> {
  if (!url) return null

  for (const candidate of renditionCandidates(url)) {
    const got = await tryFetchImage(candidate)
    if (!got) continue

    const size = imageSize(got.buf)
    const label = /_(\d+)_(\d+)/.exec(candidate)?.[0]?.replace(/_/g, 'x').slice(1) ?? 'original'
    console.log('[linkedin] photo', label, size ? size.width + 'x' + size.height : 'unknown', got.buf.byteLength + 'b')

    return {
      dataUrl: 'data:' + got.type + ';base64,' + got.buf.toString('base64'),
      width:   size?.width  ?? null,
      height:  size?.height ?? null,
      source:  label,
    }
  }

  console.error('[linkedin] no photo rendition could be fetched')
  return null
}

// ── Posting ──────────────────────────────────────────────────────────────────

const RESERVED = /[|{}@[\]()<>#*_~\\]/g
const URL_RE   = /https?:\/\/[^\s]+/g

/**
 * The Posts API `commentary` field uses LinkedIn's "Little Text" format, where
 * the reserved characters above must be backslash-escaped or the request 422s
 * with an unhelpful error.
 *
 * URLs are deliberately left verbatim. `utm_source` and `utm_campaign` both
 * contain underscores, so escaping them rewrites the link to `utm\_source` and
 * quietly breaks campaign tracking on every post — a failure nobody notices
 * until the analytics are already wrong. Leaving the URL alone fails loudly
 * (a 422 on the very first test post) rather than silently, which is the
 * failure mode we want.
 */
export function escapeCommentary(text: string): string {
  let out   = ''
  let last  = 0
  URL_RE.lastIndex = 0

  for (let m = URL_RE.exec(text); m; m = URL_RE.exec(text)) {
    out += text.slice(last, m.index).replace(RESERVED, c => '\\' + c)
    out += m[0]
    last = m.index + m[0].length
  }
  return out + text.slice(last).replace(RESERVED, c => '\\' + c)
}

function restHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization:               'Bearer ' + accessToken,
    'Content-Type':              'application/json',
    'LinkedIn-Version':          LINKEDIN_VERSION,
    'X-Restli-Protocol-Version': '2.0.0',
  }
}

/**
 * Publish a native image post to the member's own feed.
 *
 * Native image posts are deliberate: a link post (the og:image trick) gets
 * reach-suppressed by LinkedIn. The event URL goes in the commentary instead.
 *
 * Three calls: initialize upload -> PUT bytes -> create post.
 * Returns the post URN, or throws with a readable message.
 */
export async function publishImagePost(params: {
  accessToken: string
  sub:         string
  imageBytes:  Buffer
  commentary:  string
  altText?:    string
}): Promise<string> {
  const { accessToken, sub, imageBytes, commentary, altText } = params
  const owner = 'urn:li:person:' + sub

  // 1 — initialize upload
  const initRes = await fetch(REST_BASE + '/images?action=initializeUpload', {
    method:  'POST',
    headers: restHeaders(accessToken),
    body:    JSON.stringify({ initializeUploadRequest: { owner } }),
  })
  const initJson = await initRes.json()
  if (!initRes.ok || !initJson?.value?.uploadUrl) {
    console.error('[linkedin] initializeUpload failed:', initRes.status, JSON.stringify(initJson).slice(0, 300))
    throw new Error('Could not start the image upload with LinkedIn')
  }
  const { uploadUrl, image: imageUrn } = initJson.value

  // 2 — upload the bytes
  const upRes = await fetch(uploadUrl, {
    method:  'PUT',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'image/jpeg' },
    // Uint8Array, not the Buffer itself: fetch's BodyInit does not accept a
    // Node Buffer under these lib types, and tsc fails the whole build — which
    // takes `npm test` with it. Same wrapping as qna-storage's putObject.
    body:    new Uint8Array(imageBytes),
  })
  if (!upRes.ok) {
    console.error('[linkedin] image upload failed:', upRes.status, (await upRes.text()).slice(0, 300))
    throw new Error('Could not upload the image to LinkedIn')
  }

  // 3 — create the post
  const postRes = await fetch(REST_BASE + '/posts', {
    method:  'POST',
    headers: restHeaders(accessToken),
    body:    JSON.stringify({
      author:       owner,
      commentary:   escapeCommentary(commentary),
      visibility:   'PUBLIC',
      distribution: {
        feedDistribution:               'MAIN_FEED',
        targetEntities:                 [],
        thirdPartyDistributionChannels: [],
      },
      content:        { media: { id: imageUrn, altText: altText || 'Event badge' } },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
  })
  if (!postRes.ok) {
    const body = (await postRes.text()).slice(0, 300)
    console.error('[linkedin] create post failed:', postRes.status, body)
    if (postRes.status === 403) throw new Error('LinkedIn refused the post — the w_member_social permission is missing')
    if (postRes.status === 426) throw new Error('LinkedIn API version is out of date — bump LINKEDIN_API_VERSION')
    throw new Error('LinkedIn rejected the post')
  }

  const urn = postRes.headers.get('x-restli-id') || ''
  console.log('[linkedin] post published:', urn)
  return urn
}
