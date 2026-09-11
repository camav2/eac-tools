/*
 * Reading a model's reply.
 *
 * The two parsers are the seam between "what the vendor sent" and "what the
 * runner acts on". A tool call that is silently dropped here means an agent
 * that appears to do nothing; a mis-read usage field means a cost figure that
 * is quietly wrong on every run. Both are pure functions, so both are pinned.
 *
 * The broken-JSON case matters most. Cheaper models on OpenRouter do emit
 * malformed arguments, and the right response is a tool error the model can
 * read and fix, not a crashed run at 3am.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseAnthropicTurn,
  parseOpenAiTurn,
  getProvider,
  providerCatalogue,
  PROVIDERS,
} from '../api/_lib/tend-providers'

test('anthropic: text, tool calls and usage come through, content kept whole', () => {
  const data = {
    content: [
      { type: 'thinking', thinking: '', signature: 'sig123' },
      { type: 'text', text: 'Checking the roster.' },
      { type: 'tool_use', id: 'tu_1', name: 'circle_list_members', input: {} },
      { type: 'tool_use', id: 'tu_2', name: 'fetch_webpage', input: { url: 'https://x.test' } },
    ],
    usage: { input_tokens: 1200, output_tokens: 80 },
  }
  const turn = parseAnthropicTurn(data)

  assert.equal(turn.text, 'Checking the roster.')
  assert.deepEqual(turn.toolCalls.map(c => c.name), ['circle_list_members', 'fetch_webpage'])
  assert.deepEqual(turn.toolCalls[1].input, { url: 'https://x.test' })
  assert.deepEqual(turn.usage, { input: 1200, output: 80 })
  // The signed thinking block must survive untouched for replay.
  assert.deepEqual(turn.assistantMessages, [{ role: 'assistant', content: data.content }])
})

test('anthropic: an empty reply is not an error', () => {
  const turn = parseAnthropicTurn({ content: [], usage: {} })
  assert.equal(turn.text, '')
  assert.equal(turn.toolCalls.length, 0)
  assert.deepEqual(turn.usage, { input: 0, output: 0 })
})

test('openai-compatible: tool_calls arguments are parsed from JSON strings', () => {
  const message = {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'airtable_find_person', arguments: '{"name":"Jane Doe"}' } },
    ],
    reasoning_details: [{ type: 'reasoning.text', text: 'hidden' }],
  }
  const turn = parseOpenAiTurn({
    choices: [{ message }],
    usage: { prompt_tokens: 300, completion_tokens: 40 },
  })

  assert.equal(turn.text, '')
  assert.deepEqual(turn.toolCalls, [{ id: 'call_1', name: 'airtable_find_person', input: { name: 'Jane Doe' } }])
  assert.deepEqual(turn.usage, { input: 300, output: 40 })
  // Whole message stored verbatim, reasoning_details included.
  assert.deepEqual(turn.assistantMessages, [message])
})

test('openai-compatible: broken argument JSON becomes a parseError, not a crash', () => {
  const turn = parseOpenAiTurn({
    choices: [{ message: {
      role: 'assistant',
      tool_calls: [{ id: 'call_x', function: { name: 'send_email', arguments: '{"to": "a@b.c", "subject": ' } }],
    } }],
  })
  assert.equal(turn.toolCalls.length, 1)
  assert.equal(turn.toolCalls[0].name, 'send_email')
  assert.deepEqual(turn.toolCalls[0].input, {})
  assert.ok(turn.toolCalls[0].parseError, 'parseError should be set')
})

test('openai-compatible: prose reply with no tools is the summary', () => {
  const turn = parseOpenAiTurn({
    choices: [{ message: { role: 'assistant', content: '  Nothing new this week.  ' } }],
  })
  assert.equal(turn.text, 'Nothing new this week.')
  assert.equal(turn.toolCalls.length, 0)
})

test('openai-compatible: no choices is a hard error', () => {
  assert.throws(() => parseOpenAiTurn({ choices: [] }), /no choices/)
})

test('catalogue: a provider is offered only when its key is set, Claude always', () => {
  // The env is passed in, so the test never touches the real process.env.
  const claudeOnly = providerCatalogue({ ANTHROPIC_API_KEY: 'sk-x' })
  assert.deepEqual(claudeOnly.map(p => p.id), ['anthropic'])

  const both = providerCatalogue({ ANTHROPIC_API_KEY: 'sk-x', OPENROUTER_API_KEY: 'or-x' })
  assert.deepEqual(both.map(p => p.id), ['anthropic', 'openrouter'])

  // Anthropic is listed even with nothing set: an empty picker is a worse
  // failure than a run that reports a missing key.
  assert.deepEqual(providerCatalogue({}).map(p => p.id), ['anthropic'])
})

test('registry: every provider has a default model it actually lists or allows', () => {
  for (const p of PROVIDERS) {
    const listed = p.models.some(m => m.id === p.defaultModel)
    assert.ok(listed || p.freeText, `${p.id} default ${p.defaultModel} is not selectable`)
  }
  assert.equal(getProvider('anthropic')?.kind, 'anthropic')
  assert.equal(getProvider('openrouter')?.kind, 'openai-compatible')
  assert.equal(getProvider('cursor'), undefined)
})
