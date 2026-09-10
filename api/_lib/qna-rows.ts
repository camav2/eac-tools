/*
 * Shared shape of an Author Editorial Q&A pipeline row.
 *
 * Three handlers (qna-intake, qna-audio, qna-suggest) all need the same
 * answer: "what is the full list of questions for this author, and where do
 * this row's answers sit against it?" That list is no longer just the Question
 * Set — an author may append up to two questions of their own — and a handler
 * that computes it differently from its neighbours silently misfiles an
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
 * Anything past the Question Set that is flagged and actually has question
 * text. Compaction matters: an author can create a slot and leave it blank,
 * and on the next page load that empty slot should disappear without
 * stranding the answer or recording that belongs to the slot after it — which
 * is why whole entries are carried here, never just the question strings.
 */
export function authorEntries(row: any): QnaResponse[] {
  const base = baseQuestions(row).length
  return parseJsonArray(row.fields['Responses'])
    .slice(base)
    .filter((r: any) => r?.authorAdded && String(r?.question ?? '').trim())
    .slice(0, MAX_AUTHOR_QUESTIONS)
    .map((r: any) => ({
      question:   String(r.question).trim(),
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
 * Submit-time cleanup: an author-added question with no answer behind it is
 * a slot they opened and thought better of. Cam should never see it.
 */
export function dropEmptyAuthorQuestions(
  responses: QnaResponse[],
  baseCount: number
): QnaResponse[] {
  return responses.filter((r, i) => i < baseCount || isAnswered(r))
}
