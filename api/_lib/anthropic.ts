/*
 * Anthropic API — Author Editorial Q&A question generation
 *
 * Raw fetch against api.anthropic.com/v1/messages (house style — no SDK).
 *
 * claude-opus-5 uses adaptive thinking with output_config.effort — the older
 * {type:'enabled', budget_tokens} form is rejected with a 400. Thinking is on
 * by default on this model; the explicit adaptive block is equivalent and
 * self-documenting. tool_choice stays 'auto' (a specific tool can't be forced
 * while thinking is on), so the system prompt guarantees the tool call.
 *
 * Env vars required: ANTHROPIC_API_KEY
 */

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-opus-5'

const RECENT_BLUEPRINT = `
This author has just published or is close to launch. Capture the immediacy —
what they're learning right now through writing, publishing, and starting to
share their ideas publicly. Useful themes: what writing the book clarified;
what surprised them about the process; what they learned about their topic by
writing it; how the book sharpened how they articulate their expertise; what
changed once they started sharing the work publicly; why their topic matters
now; what they'd tell someone at the start of the process.`.trim()

const ESTABLISHED_BLUEPRINT = `
This author's book has been out a while (roughly 2+ years). Capture the
evergreen, time-tested value — what has endured, not what's exciting right
now. Useful themes: what they still value from the process years later; how
their thinking has evolved since publication; what they now understand about
their topic that they didn't then; what lesson from writing still feels
relevant; what the book has continued to make possible for their work,
reputation, or clarity; what they'd approach differently now; what remains
timeless about the process regardless of how the market or AI landscape has
shifted.`.trim()

const RETURN_QUESTIONS_TOOL = {
  name: 'return_questions',
  description: 'Return the final 6 personalised interview questions for this author.',
  input_schema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: { type: 'string' },
        minItems: 6,
        maxItems: 6,
        description: 'Exactly 6 questions, in the order they should be asked.',
      },
    },
    required: ['questions'],
  },
}

export interface QuestionGenContext {
  authorName: string
  bookTitle: string
  bucket: 'Recent' | 'Established'
  publishedDate: string | null
  shortSummary?: string
  longSummary?: string
}

function systemPrompt(bucket: 'Recent' | 'Established'): string {
  const blueprint = bucket === 'Recent' ? RECENT_BLUEPRINT : ESTABLISHED_BLUEPRINT
  return `You are drafting interview questions for EAC's Author Editorial Q&A — a magazine-style interview series with Expert Author Community authors, published to each author's profile page.

CRITICAL — this is explicitly NOT a testimonial. Never write questions that fish for praise of EAC, the programme, or Kelly Irving ("how did EAC help you", "what did you love about the community"). The value comes entirely from the author's own thinking about writing, publishing, and their subject — never from promotional content. If a question could be answered with marketing copy, it's the wrong question.

Bucket: ${bucket}
${blueprint}

Process: silently brainstorm 15-20 candidate questions across the themes above, tailored specifically to this author's actual book, topic, and stage — then select and refine your strongest 6. Order them so the interview builds naturally (open broad, then specific, then reflective/forward-looking). Each question should be answerable in a few sentences to a couple of paragraphs, read like something a good magazine editor would ask, and reference the author's real book/topic where it sharpens the question. Avoid generic phrasing that could apply to any author.

Call return_questions with exactly 6 questions and nothing else.`
}

function userPrompt(ctx: QuestionGenContext): string {
  const lines = [
    `Author: ${ctx.authorName}`,
    `Book: ${ctx.bookTitle}`,
    ctx.publishedDate ? `Published: ${ctx.publishedDate}` : null,
    ctx.shortSummary ? `Short summary: ${ctx.shortSummary}` : null,
    ctx.longSummary ? `Long summary: ${ctx.longSummary}` : null,
  ].filter(Boolean)
  return lines.join('\n')
}

export async function generateQuestions(ctx: QuestionGenContext): Promise<string[]> {
  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'x-api-key':         process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
      'Content-Type':      'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: systemPrompt(ctx.bucket),
      messages: [{ role: 'user', content: userPrompt(ctx) }],
      tools: [RETURN_QUESTIONS_TOOL],
      tool_choice: { type: 'auto' },
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`)
  }

  const data = await res.json()
  const toolUse = (data.content ?? []).find(
    (b: any) => b.type === 'tool_use' && b.name === 'return_questions'
  )
  if (!toolUse) throw new Error('Model did not return questions via tool call')

  const questions = toolUse.input?.questions
  if (!Array.isArray(questions) || questions.length !== 6) {
    throw new Error(
      `Expected exactly 6 questions, got ${Array.isArray(questions) ? questions.length : typeof questions}`
    )
  }
  return questions
}
