/*
 * EAC Tend — model providers
 *
 * Every teammate picks a provider and a model. This file is the registry of
 * providers and the two adapters that turn "call the model with these tools"
 * into each vendor's wire format.
 *
 * Two wire formats cover the market:
 *   anthropic          — /v1/messages, content blocks, tool_use / tool_result
 *   openai-compatible  — /chat/completions, tool_calls / role:'tool'
 *
 * OpenRouter speaks the second, and so does nearly everything else that is
 * not Anthropic. So a new provider is a registry row with a base URL, not a
 * new adapter. (Cursor is deliberately absent: its API runs coding agents on
 * a repo and does not expose inference. Add it here the day it does.)
 *
 * THE ONE RULE: the assistant message that comes back from a provider is
 * stored and replayed VERBATIM in the provider's own shape. Anthropic thinking
 * blocks carry signatures; OpenRouter reasoning models return
 * reasoning_details that must be echoed back. Neither survives being
 * "normalised". So a run's transcript is provider-native, the run is pinned to
 * the provider that started it, and the runner only ever sees the small
 * ModelTurn view below.
 *
 * Raw fetch, house style — no SDK.
 *
 * Env vars required: ANTHROPIC_API_KEY, OPENROUTER_API_KEY (per provider)
 */

export type ProviderId = 'anthropic' | 'openrouter'
export type Effort = 'low' | 'medium' | 'high'

export interface ProviderModel { id: string; label: string }

export interface Provider {
  id:           ProviderId
  label:        string
  kind:         'anthropic' | 'openai-compatible'
  baseUrl:      string
  envKey:       string
  /** Curated suggestions shown in the picker. */
  models:       ProviderModel[]
  /** True when any model id may be typed — OpenRouter lists hundreds. */
  freeText:     boolean
  defaultModel: string
  /** Where to look up ids when freeText is on. */
  modelsUrl?:   string
}

export const PROVIDERS: Provider[] = [
  {
    id:      'anthropic',
    label:   'Claude (Anthropic direct)',
    kind:    'anthropic',
    baseUrl: 'https://api.anthropic.com/v1/messages',
    envKey:  'ANTHROPIC_API_KEY',
    models: [
      { id: 'claude-opus-5',     label: 'Claude Opus 5 — best judgement' },
      { id: 'claude-sonnet-5',   label: 'Claude Sonnet 5 — fast, strong' },
      { id: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5 — cheapest' },
      { id: 'claude-fable-5-1',  label: 'Claude Fable 5.1 — most capable, priciest' },
    ],
    freeText:     false,
    defaultModel: 'claude-opus-5',
  },
  {
    id:      'openrouter',
    label:   'OpenRouter (any vendor)',
    kind:    'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    envKey:  'OPENROUTER_API_KEY',
    // Deliberately a short list. OpenRouter's catalogue changes weekly and a
    // stale list is worse than none. Free text is on; these are just starters.
    models: [
      { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5 via OpenRouter' },
      { id: 'openai/gpt-5',              label: 'GPT-5' },
      { id: 'google/gemini-2.5-pro',     label: 'Gemini 2.5 Pro' },
    ],
    freeText:     true,
    defaultModel: 'anthropic/claude-sonnet-5',
    modelsUrl:    'https://openrouter.ai/models',
  },
]

const BY_ID = new Map(PROVIDERS.map(p => [p.id, p]))

export function getProvider(id: string): Provider | undefined {
  return BY_ID.get(id as ProviderId)
}

/**
 * Providers the UI should offer: only those whose API key is present, so a
 * brain nobody has paid for never shows up in the picker. Anthropic is always
 * listed — without its key nothing in this app works anyway, and an empty
 * picker would be a worse error than a failed run.
 */
export function providerCatalogue(env: NodeJS.ProcessEnv = process.env) {
  return PROVIDERS
    .filter(p => p.id === 'anthropic' || Boolean(env[p.envKey]))
    .map(({ id, label, models, freeText, defaultModel, modelsUrl }) =>
      ({ id, label, models, freeText, defaultModel, modelsUrl }))
}

// ── The view the runner sees ──────────────────────────────────────────────────

export interface ToolDef {
  name:         string
  description:  string
  input_schema: Record<string, unknown>
}

export interface ToolCall {
  id:    string
  name:  string
  input: any
  /** Set when the provider returned arguments that were not valid JSON. */
  parseError?: string
}

export interface ToolOutcome {
  id:       string
  content:  string
  isError?: boolean
}

export interface ModelTurn {
  /** Provider-native assistant message(s). Stored verbatim. */
  assistantMessages: any[]
  text:      string
  toolCalls: ToolCall[]
  usage:     { input: number; output: number }
}

export interface CallOptions {
  model:    string
  effort:   Effort
  system:   string
  messages: any[]
  tools:    ToolDef[]
}

export interface ProviderAdapter {
  call(opts: CallOptions): Promise<ModelTurn>
  /** The user-side message(s) that carry tool results back to the model. */
  toolResultMessages(results: ToolOutcome[]): any[]
  /** The opening user message for a fresh run. */
  initialMessages(text: string): any[]
}

function apiKeyFor(p: Provider): string {
  const key = process.env[p.envKey]
  if (!key) throw new Error(`${p.label}: ${p.envKey} is not set`)
  return key
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

/**
 * claude-opus-5 and newer use adaptive thinking with output_config.effort;
 * tool_choice stays 'auto' because a tool cannot be forced while thinking is
 * on. The system prompt is what guarantees the finish call.
 */
function anthropicAdapter(p: Provider): ProviderAdapter {
  return {
    async call({ model, effort, system, messages, tools }) {
      const res = await fetch(p.baseUrl, {
        method: 'POST',
        headers: {
          'x-api-key':         apiKeyFor(p),
          'anthropic-version': '2023-06-01',
          'Content-Type':      'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens:    16000,
          thinking:      { type: 'adaptive' },
          output_config: { effort },
          system,
          messages,
          tools,
          tool_choice:   { type: 'auto' },
        }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`)
      }
      const data = await res.json()
      return parseAnthropicTurn(data)
    },

    toolResultMessages(results) {
      return [{
        role: 'user',
        content: results.map(r => ({
          type:        'tool_result',
          tool_use_id: r.id,
          content:     r.content,
          ...(r.isError ? { is_error: true } : {}),
        })),
      }]
    },

    initialMessages(text) {
      return [{ role: 'user', content: text }]
    },
  }
}

/** Pure, so it can be tested without a network. */
export function parseAnthropicTurn(data: any): ModelTurn {
  const content: any[] = data?.content ?? []
  return {
    assistantMessages: [{ role: 'assistant', content }],
    text: content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim(),
    toolCalls: content
      .filter(b => b.type === 'tool_use')
      .map(b => ({ id: b.id, name: b.name, input: b.input ?? {} })),
    usage: {
      input:  data?.usage?.input_tokens  ?? 0,
      output: data?.usage?.output_tokens ?? 0,
    },
  }
}

// ── OpenAI-compatible (OpenRouter and friends) ────────────────────────────────

/**
 * The system prompt travels as messages[0] rather than a top-level field, so
 * it is prepended on every call and never stored in the run — same outcome as
 * Anthropic's `system`, and the transcript stays free of it.
 *
 * `reasoning: { effort }` is OpenRouter's normalised knob; models without
 * reasoning ignore it. Whatever the model returns (content, tool_calls,
 * reasoning, reasoning_details) is stored as one assistant message, verbatim.
 */
function openAiCompatibleAdapter(p: Provider): ProviderAdapter {
  return {
    async call({ model, effort, system, messages, tools }) {
      const res = await fetch(p.baseUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKeyFor(p)}`,
          'Content-Type':  'application/json',
          'X-Title':       'Tend',
        },
        body: JSON.stringify({
          model,
          max_tokens: 16000,
          reasoning:  { effort },
          messages:   [{ role: 'system', content: system }, ...messages],
          tools: tools.map(t => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.input_schema },
          })),
          tool_choice: 'auto',
        }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`${p.label} ${res.status}: ${body.slice(0, 300)}`)
      }
      const data = await res.json()
      return parseOpenAiTurn(data)
    },

    toolResultMessages(results) {
      // One role:'tool' message per call. Errors are plain text here; the
      // format has no is_error flag, so the word "Error:" in the content is
      // what the model sees — executeBlock already prefixes it.
      return results.map(r => ({ role: 'tool', tool_call_id: r.id, content: r.content }))
    },

    initialMessages(text) {
      return [{ role: 'user', content: text }]
    },
  }
}

/** Pure, so it can be tested without a network. */
export function parseOpenAiTurn(data: any): ModelTurn {
  const message = data?.choices?.[0]?.message
  if (!message) throw new Error('Provider returned no choices')

  const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc: any) => {
    const raw = tc?.function?.arguments ?? '{}'
    try {
      return { id: tc.id, name: tc.function?.name ?? '', input: raw ? JSON.parse(raw) : {} }
    } catch (err: any) {
      // A weaker model can emit broken JSON. Surface it as a tool error the
      // model can read and retry from, rather than killing the run.
      return { id: tc.id, name: tc.function?.name ?? '', input: {}, parseError: String(err?.message ?? err) }
    }
  })

  const text = typeof message.content === 'string'
    ? message.content.trim()
    : Array.isArray(message.content)
      ? message.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n').trim()
      : ''

  return {
    assistantMessages: [message],
    text,
    toolCalls,
    usage: {
      input:  data?.usage?.prompt_tokens     ?? 0,
      output: data?.usage?.completion_tokens ?? 0,
    },
  }
}

// ── Lookup ────────────────────────────────────────────────────────────────────

export function adapterFor(providerId: string): ProviderAdapter {
  const p = getProvider(providerId)
  if (!p) throw new Error(`Unknown provider: ${providerId}`)
  return p.kind === 'anthropic' ? anthropicAdapter(p) : openAiCompatibleAdapter(p)
}
