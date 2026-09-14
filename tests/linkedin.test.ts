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

import { escapeCommentary, postingEnabled, authorizeUrl } from '../api/_lib/linkedin'

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
