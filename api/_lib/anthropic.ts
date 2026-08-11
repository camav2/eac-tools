/*
 * Anthropic API — Author Editorial Q&A question generation and draft assembly
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

/** Shared call shape. Returns the named tool_use block's input. */
async function callWithTool(
  system: string,
  userContent: string,
  tool: { name: string; description: string; input_schema: unknown }
): Promise<any> {
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
      system,
      messages: [{ role: 'user', content: userContent }],
      tools: [tool],
      tool_choice: { type: 'auto' },
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`)
  }

  const data = await res.json()
  const toolUse = (data.content ?? []).find(
    (b: any) => b.type === 'tool_use' && b.name === tool.name
  )
  if (!toolUse) throw new Error(`Model did not call ${tool.name}`)
  return toolUse.input
}

export async function generateQuestions(ctx: QuestionGenContext): Promise<string[]> {
  const input = await callWithTool(
    systemPrompt(ctx.bucket),
    userPrompt(ctx),
    RETURN_QUESTIONS_TOOL
  )

  const questions = input?.questions
  if (!Array.isArray(questions) || questions.length !== 6) {
    throw new Error(
      `Expected exactly 6 questions, got ${Array.isArray(questions) ? questions.length : typeof questions}`
    )
  }
  return questions
}

/* ────────────────────────────────────────────────────────────────────────────
 * Draft assembly
 * ──────────────────────────────────────────────────────────────────────────*/

const RETURN_DRAFT_TOOL = {
  name: 'return_draft',
  description: 'Return the edited magazine Q&A draft.',
  input_schema: {
    type: 'object',
    properties: {
      standfirst: {
        type: 'string',
        description:
          'A 1-2 sentence editorial introduction placed above the Q&A. States what this ' +
          'interview is about, drawn only from what the author actually said. No praise, no hype.',
      },
      items: {
        type: 'array',
        description: 'The edited Q&A pairs, in the original question order. Omit unanswered questions.',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question, lightly edited for print.' },
            answer:   { type: 'string', description: "The author's edited answer." },
          },
          required: ['question', 'answer'],
        },
      },
      editorNotes: {
        type: 'string',
        description:
          'Notes for the human editor: anything cut and why, claims that may need checking, ' +
          'places the answer was thin. Not for publication. Empty string if nothing to flag.',
      },
    },
    required: ['standfirst', 'items', 'editorNotes'],
  },
}

export interface DraftAnswer {
  question: string
  text?: string
  transcript?: string
}

export interface DraftContext {
  authorName: string
  bookTitle: string
  bucket: 'Recent' | 'Established' | string
  answers: DraftAnswer[]
}

const DRAFT_SYSTEM = `You are editing an interview for EAC's Author Editorial Q&A — a magazine-style interview series with Expert Author Community authors, published on each author's profile page.

Your job is EDITING, not writing. The author has already answered. You are the editor who makes their answers read well in print without putting words in their mouth.

## The one rule that overrides everything

Every substantive claim, opinion, example and fact in your output must come from what the author actually said. You may cut, tighten, reorder within an answer, and fix grammar. You may NOT invent, embellish, infer, or "improve" their thinking. If an answer is thin, let it be thin — a short honest answer is better than a padded one. Never fabricate a quote.

## This is NOT a testimonial

The series exists to show the depth of the author's thinking about writing, publishing and their subject. It is not promotional material for EAC.

If the author volunteered praise for EAC, Kelly Irving, or the programme, CUT IT. Not because it's untrue, but because it isn't what this series is for, and it cheapens everything around it. Keep the substance of what they learned; drop the endorsement. The reader should finish thinking "that person thinks carefully about their work" — not "that programme sounds good".

## Editing spoken answers

Answers marked [SPOKEN] are transcripts. People speak differently from how they write, and a verbatim transcript reads badly in print. For these:
- Remove filler ("um", "like", "you know"), false starts, and repeated run-ups to the same point.
- Join fragments into complete sentences where the meaning is unambiguous.
- Cut tangents that go nowhere, and side-comments to the interviewer.
- Keep their actual vocabulary, their rhythm, and their specific examples. Do not translate a plain-spoken answer into polished prose — the point is that it still sounds like them.
- Keep a hesitation or self-correction when it carries real meaning ("I thought X — actually, no, it was more that Y").

Answers marked [WRITTEN] were typed. Edit these much more lightly: typos, obvious slips, and clear redundancy only. If in doubt, leave written answers alone.

## The questions

Lightly edit questions for print — trim throat-clearing, keep them crisp. They must remain recognisably the same question the author was asked. If an answer clearly responds to something other than what was asked, adjust the question to fit the answer rather than the reverse, and flag it in editorNotes.

## Length and shape

Don't pad, and don't compress an answer to the point of losing its texture. A good answer keeps the specific detail — the example, the number, the moment — and loses the throat-clearing around it. Omit any question the author did not answer; do not invent an answer for it.

## The standfirst

1-2 sentences introducing the interview. Grounded in what the author actually said — not a summary of their book, and not a claim about their importance. Plain and specific. No "In this fascinating interview…".

Call return_draft and nothing else.`

function draftUserPrompt(ctx: DraftContext): string {
  const parts = [
    `Author: ${ctx.authorName}`,
    `Book: ${ctx.bookTitle}`,
    `Bucket: ${ctx.bucket}`,
    '',
    'Answers follow. Each is tagged [WRITTEN] or [SPOKEN] — edit accordingly.',
    '',
  ]

  ctx.answers.forEach((a, i) => {
    parts.push(`--- Question ${i + 1} ---`)
    parts.push(a.question)
    parts.push('')
    if (a.text?.trim()) {
      parts.push('[WRITTEN]')
      parts.push(a.text.trim())
      parts.push('')
    }
    if (a.transcript?.trim()) {
      parts.push('[SPOKEN]')
      parts.push(a.transcript.trim())
      parts.push('')
    }
    if (!a.text?.trim() && !a.transcript?.trim()) {
      parts.push('(no answer given — omit this question from the draft)')
      parts.push('')
    }
  })

  return parts.join('\n')
}

export interface Draft {
  standfirst: string
  items: Array<{ question: string; answer: string }>
  editorNotes: string
}

export async function generateDraft(ctx: DraftContext): Promise<Draft> {
  const input = await callWithTool(DRAFT_SYSTEM, draftUserPrompt(ctx), RETURN_DRAFT_TOOL)

  if (!Array.isArray(input?.items) || input.items.length === 0) {
    throw new Error('Model returned no Q&A items')
  }
  return {
    standfirst:  String(input.standfirst ?? ''),
    items:       input.items.map((it: any) => ({
      question: String(it?.question ?? ''),
      answer:   String(it?.answer ?? ''),
    })),
    editorNotes: String(input.editorNotes ?? ''),
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Book Canvas follow-up — personalised research email content
 * ──────────────────────────────────────────────────────────────────────────*/

const RETURN_FOLLOWUP_TOOL = {
  name: 'return_followup',
  description: 'Return the personalised observation and question for the follow-up email.',
  input_schema: {
    type: 'object',
    properties: {
      observation: {
        type: 'string',
        description:
          'One short sentence (max ~25 words) showing Cameron actually read their canvas. ' +
          'References their specific idea or where they got stuck, in plain words. ' +
          'A statement — must not contain a question mark.',
      },
      question: {
        type: 'string',
        description:
          'Exactly one open question (max ~30 words) that digs at the real challenge behind ' +
          'their answers — the thing the canvas could not tell them. Ends with a question mark.',
      },
    },
    required: ['observation', 'question'],
  },
}

export interface CanvasFollowUpContext {
  firstName: string
  isMember:  boolean
  /** Pillar label -> what they wrote ('' if left blank) */
  pillars:   Record<string, string>
}

const FOLLOWUP_SYSTEM = `You are drafting two sentences for a personal follow-up email from Cameron McGrane, who runs the tools behind the Expert Author Community's Book Screening Canvas. The recipient completed the canvas - nine short prompts mapping a nonfiction book idea (purpose, positioning, audience, problem, market fit, unique value, platform, objective, strategy).

The email's only goal is research: start a real reply conversation that surfaces what this person is actually wrestling with - the unspoken problem behind their answers. It is never a pitch.

You return two things:

1. observation - one sentence proving a human read their canvas. Reference their specific idea or pattern in their answers (e.g. a sharp problem statement but an empty audience pillar, or the gap between their objective and their platform). Plain words, no praise, no analysis-speak. A statement, never a question.

2. question - ONE open question that goes underneath their answers. The best questions probe the gap between what they wrote and what they are avoiding: the pillar they skipped, the tension between two answers, or what they were hoping the canvas would settle for them. It should feel like a sharp, kind editor asking the thing nobody else has asked them. Answerable in a reply email of a few sentences.

Rules - all hard:
- Use hyphens, never em dashes.
- No exclamation marks.
- No praise-fishing, no flattery ("love your idea"), no marketing language.
- Never pitch or mention any programme, product, community, or call.
- Never quote their canvas back at length - reference, don't recite.
- One question total. The observation must contain zero questions.
- If most pillars are blank, do not shame them - the observation notes where they stopped, and the question probes what they were hoping to figure out or what stopped them.
- Write for a busy expert: plain, warm, direct. No jargon, no "unpack", no "journey".

Call return_followup and nothing else.`

function followUpUserPrompt(ctx: CanvasFollowUpContext): string {
  const lines = [
    `First name: ${ctx.firstName || '(unknown)'}`,
    `EAC member: ${ctx.isMember ? 'yes' : 'no'}`,
    '',
    'Their canvas (blank pillars shown as [not answered]):',
    '',
  ]
  for (const [label, answer] of Object.entries(ctx.pillars)) {
    lines.push(`${label}: ${answer.trim() || '[not answered]'}`)
  }
  return lines.join('\n')
}

export interface CanvasFollowUp {
  observation: string
  question:    string
}

export async function generateCanvasFollowUp(ctx: CanvasFollowUpContext): Promise<CanvasFollowUp> {
  const input = await callWithTool(FOLLOWUP_SYSTEM, followUpUserPrompt(ctx), RETURN_FOLLOWUP_TOOL)
  const observation = String(input?.observation ?? '').trim()
  const question    = String(input?.question ?? '').trim()
  if (!observation || !question) throw new Error('Model returned empty follow-up content')
  return { observation, question }
}
