/*
 * Shared shape of an Author Editorial Q&A pipeline row.
 *
 * Both author-facing handlers (qna-intake, qna-audio) need the same answer:
 * "what is the full list of questions for this author, and where do this row's
 * answers sit against it?" That list is no longer just the Question Set — an
 * author may append up to two questions of their own, written by them — and a
 * handler that computes it differently from its neighbour silently misfiles an
 * answer or an audio path. So it lives here once.
 *
 * WHY AUTHOR QUESTIONS ARE NOT THEIR OWN AIRTABLE FIELD
 * A question the author wrote is inseparable from the answer they wrote for
 * it, and Responses already stores exactly that pairing. Splitting the text
 * into a second field would mean keeping two arrays in step through every
 * save, autosave and upload. Instead an author-added entry lives in Responses
 * past the end of the Question Set, flagged `authorAdded`.
 *
 * No env vars required.
 */

/** Ceiling on author-added questions. Two is enough for "the thing you didn't
 *  ask me"; more turns a six-question interview into an open submission. */
export const MAX_AUTHOR_QUESTIONS = 2

/** Long enough for a real question, short enough that the field can't be used
 *  to store an essay. */
export const MAX_QUESTION_CHARS = 300

export interface QnaResponse {
  question: string
  text: string
  audioPath?: string
  audioType?: string
  transcript?: string
  /** True only for questions the author added themselves. */
  authorAdded?: boolean
}

export function parseJsonArray(raw: unknown): any[] {
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Cam's reviewed set — the six. */
export function baseQuestions(row: any): string[] {
  return parseJsonArray(row.fields['Question Set']).filter(
    (q: unknown): q is string => typeof q === 'string'
  )
}

/**
 * The author's own entries, compacted.
 *
 * Anything past the Question Set that is flagged and holds something — a
 * question, an answer, or a recording. Kept deliberately loose: an author who
 * writes their answer before their question, and reloads in between, must not
 * lose the answer. Requiring both is the submit step's job, where it can be
 * said out loud rather than deleted quietly.
 *
 * Compaction matters: an author can open a slot and leave it entirely blank,
 * and on the next load that slot should disappear without stranding the answer
 * belonging to the slot after it — which is why whole entries are carried
 * here, never just the question strings.
 */
export function authorEntries(row: any): QnaResponse[] {
  const base = baseQuestions(row).length
  return parseJsonArray(row.fields['Responses'])
    .slice(base)
    .filter((r: any) =>
      r?.authorAdded &&
      (String(r?.question ?? '').trim() || String(r?.text ?? '').trim() || r?.audioPath)
    )
    .slice(0, MAX_AUTHOR_QUESTIONS)
    .map((r: any) => ({
      question:   String(r.question ?? '').trim(),
      text:       typeof r.text === 'string' ? r.text : '',
      audioPath:  r.audioPath,
      audioType:  r.audioType,
      transcript: r.transcript,
      authorAdded: true as const,
    }))
}

/** Every question this author is answering, in page order. */
export function fullQuestions(row: any): string[] {
  return [...baseQuestions(row), ...authorEntries(row).map(e => e.question)]
}

/**
 * Trims a client-supplied author question list to something storable.
 *
 * Empties are kept in place rather than dropped, so slot N on the page stays
 * slot N on the server through an autosave — a half-typed question must not
 * shuffle the answer below it. Dropping the blanks is the submit step's job.
 */
export function sanitiseAuthorQuestions(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return input
    .slice(0, MAX_AUTHOR_QUESTIONS)
    .map(q => (typeof q === 'string' ? q.trim().slice(0, MAX_QUESTION_CHARS) : ''))
}

/**
 * Rebuilds the Responses array against a question list.
 *
 * Always a merge, never a fresh build: a text autosave must not wipe a
 * recording, and an audio upload must not wipe typed answers. Callers that
 * only have one of the two pass the existing values through for the other.
 *
 * Existing entries are matched by position. Within the author range that is
 * safe because the page only ever appends a slot — it never reorders or
 * removes one mid-session, and reloads come back through authorEntries()
 * already compacted.
 */
export function buildResponses(
  questions: string[],
  baseCount: number,
  existing: any[],
  answers: (string | undefined)[]
): QnaResponse[] {
  return questions.map((question, i) => {
    const prev = existing[i] ?? {}
    const entry: QnaResponse = {
      question,
      text:       typeof answers[i] === 'string' ? (answers[i] as string) : (prev.text ?? ''),
      audioPath:  prev.audioPath,
      audioType:  prev.audioType,
      transcript: prev.transcript,
    }
    if (i >= baseCount) entry.authorAdded = true
    return entry
  })
}

/** True when the author has actually given something for this question. */
export function isAnswered(r: QnaResponse): boolean {
  return Boolean((r.text ?? '').trim() || r.audioPath)
}

/**
 * Author slots holding an answer but no question.
 *
 * Never dropped silently — the author wrote those words, and deleting them
 * because a box above was left empty is the kind of quiet loss nobody
 * forgives. Submit refuses instead, naming the slot.
 */
export function orphanedAnswers(responses: QnaResponse[], baseCount: number): number[] {
  return responses
    .map((r, i) => i)
    .filter(i => i >= baseCount && !responses[i].question.trim() && isAnswered(responses[i]))
}

/**
 * Submit-time cleanup: an author slot is only real when it has both a question
 * and an answer. A question with nothing behind it, or a slot opened and
 * thought better of, is not something Cam should ever see.
 *
 * Safe to drop these because neither carries the author's own words — anything
 * that does is caught by orphanedAnswers() before this runs.
 */
export function dropEmptyAuthorQuestions(
  responses: QnaResponse[],
  baseCount: number
): QnaResponse[] {
  return responses.filter(
    (r, i) => i < baseCount || (r.question.trim() && isAnswered(r))
  )
}
