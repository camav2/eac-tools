/*
 * LinkedIn helpers for /attending.
 *
 * Two things here are worth pinning because both fail silently and both cost
 * an afternoon to diagnose:
 *
 *   1. The Posts API `commentary` field is "Little Text", not plain text.
 *      An unescaped bracket returns a 422 whose body says nothing useful.
 *      Members write brackets and hashtags constantly, so this is the common
 *      case, not the edge case.
 *
 *   2. The requested scopes decide whether the member sees a read-only consent
 *      screen or a "post on your behalf" one. Asking for w_member_social when
 *      posting is switched off is a conversion cost for nothing.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { escapeCommentary, postingEnabled, authorizeUrl, renditionCandidates } from '../api/_lib/linkedin'

// ── commentary escaping ──────────────────────────────────────────────────────

test('ordinary prose is left completely alone', () => {
  const text = "I'll be at the EAC Open House on Thursday."
  assert.equal(escapeCommentary(text), text)
})

test('a tracking URL survives untouched', () => {
  // utm_source and utm_campaign carry underscores. Escaping them rewrites the
  // link and breaks campaign tracking silently, so URLs are left verbatim.
  const url = 'https://expertauthor.community/open-house?utm_source=linkedin&utm_campaign=open-house'
  assert.equal(escapeCommentary(url), url)
})

test('prose around a URL is still escaped', () => {
  assert.equal(
    escapeCommentary('Details (free) at https://expertauthor.community/open-house?utm_source=linkedin #writing'),
    'Details \\(free\\) at https://expertauthor.community/open-house?utm_source=linkedin \\#writing'
  )
})

test('two URLs in one caption are both preserved', () => {
  const text = 'See https://a.com/x_y and https://b.com/p_q (both)'
  assert.equal(escapeCommentary(text), 'See https://a.com/x_y and https://b.com/p_q \\(both\\)')
})

test('brackets and parentheses are escaped', () => {
  assert.equal(
    escapeCommentary('Come along (it is free) [seriously]'),
    'Come along \\(it is free\\) \\[seriously\\]'
  )
})

test('hashtags, mentions and emphasis marks are escaped', () => {
  // Members type these constantly. Any one of them 422s the post.
  assert.equal(escapeCommentary('#writing @kelly *bold* _under_ ~strike~'),
    '\\#writing \\@kelly \\*bold\\* \\_under\\_ \\~strike\\~')
})

test('a literal backslash is escaped once, not twice', () => {
  // Single pass over the string: an inserted backslash is never rescanned,
  // so this stays at exactly two characters.
  assert.equal(escapeCommentary('a\\b'), 'a\\\\b')
})

test('an escaped bracket does not pick up a second backslash', () => {
  assert.equal(escapeCommentary('\\('), '\\\\\\(')
})

// ── scope selection ──────────────────────────────────────────────────────────

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) { saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k] }
  try { fn() } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]
    }
  }
}

test('posting is off unless the flag is exactly "true"', () => {
  // Guards against a stray "TRUE" or "1" in Vercel quietly requesting write
  // access - the consent screen would change without anyone meaning it to.
  withEnv({ LINKEDIN_ENABLE_POSTING: undefined }, () => assert.equal(postingEnabled(), false))
  withEnv({ LINKEDIN_ENABLE_POSTING: '1'      }, () => assert.equal(postingEnabled(), false))
  withEnv({ LINKEDIN_ENABLE_POSTING: 'TRUE'   }, () => assert.equal(postingEnabled(), false))
  withEnv({ LINKEDIN_ENABLE_POSTING: 'true'   }, () => assert.equal(postingEnabled(), true))
})

test('read-only mode never asks the member for write access', () => {
  withEnv({ LINKEDIN_ENABLE_POSTING: undefined, LINKEDIN_CLIENT_ID: 'abc123' }, () => {
    const scope = new URL(authorizeUrl('state-1', 'https://example.com/cb')).searchParams.get('scope')
    assert.equal(scope, 'openid profile email')
  })
})

test('posting mode adds w_member_social and nothing else', () => {
  withEnv({ LINKEDIN_ENABLE_POSTING: 'true', LINKEDIN_CLIENT_ID: 'abc123' }, () => {
    const scope = new URL(authorizeUrl('state-1', 'https://example.com/cb')).searchParams.get('scope')
    assert.equal(scope, 'openid profile email w_member_social')
  })
})

test('the authorize URL carries the state and redirect back unchanged', () => {
  // The callback compares state against a cookie; if it is dropped or
  // re-encoded here every sign-in fails the CSRF check.
  withEnv({ LINKEDIN_CLIENT_ID: 'abc123' }, () => {
    const u = new URL(authorizeUrl('st-ate_1', 'https://hub.expertauthor.community/api/attending-callback'))
    assert.equal(u.origin + u.pathname, 'https://www.linkedin.com/oauth/v2/authorization')
    assert.equal(u.searchParams.get('state'), 'st-ate_1')
    assert.equal(u.searchParams.get('redirect_uri'), 'https://hub.expertauthor.community/api/attending-callback')
    assert.equal(u.searchParams.get('response_type'), 'code')
    assert.equal(u.searchParams.get('client_id'), 'abc123')
  })
})

// ── photo renditions ─────────────────────────────────────────────────────────

test('a 100px portrait asks the CDN for bigger copies first, original last', () => {
  // The OIDC claim hands over a 100x100 image that gets blown up ~4x into the
  // badge. Larger renditions sit behind the same signature, so we try those
  // before settling for the soft one.
  const url = 'https://media.licdn.com/dms/image/v2/D5603AQ/profile-displayphoto-shrink_100_100/B56?e=1&v=beta&t=xyz'
  const out = renditionCandidates(url)

  assert.equal(out.length, 4)
  assert.match(out[0], /shrink_800_800/)
  assert.match(out[1], /shrink_400_400/)
  assert.match(out[2], /shrink_200_200/)
  assert.equal(out[3], url, 'the untouched URL must always be the last resort')
})

test('the signature and query string are never disturbed', () => {
  const url = 'https://media.licdn.com/dms/image/profile-displayphoto-shrink_100_100/B56?e=1&v=beta&t=sig%3D%3D'
  for (const c of renditionCandidates(url)) {
    assert.match(c, /\?e=1&v=beta&t=sig%3D%3D$/)
  }
})

test('a portrait already larger than our candidates is left alone', () => {
  // No point requesting 400 when LinkedIn already gave us 800.
  const url = 'https://media.licdn.com/dms/image/profile-displayphoto-shrink_800_800/B56?t=x'
  assert.deepEqual(renditionCandidates(url), [url])
})

test('the scale_ variant is upgraded too', () => {
  const url = 'https://media.licdn.com/dms/image/profile-displayphoto-scale_100_100/B56?t=x'
  assert.match(renditionCandidates(url)[0], /scale_800_800/)
})

test('an unrecognised URL is passed straight through', () => {
  // If LinkedIn changes the path format we must degrade to today's behaviour,
  // not start requesting URLs that 404.
  const url = 'https://media.licdn.com/dms/image/something-else/B56?t=x'
  assert.deepEqual(renditionCandidates(url), [url])
})
