/*
 * EAC house style, enforced rather than requested.
 *
 * No em dashes. Cam's rule, and the drafter kept breaking it - it turned
 * "given up coffee which may be" into "given up coffee — which may be" and
 * put a mark into an author's mouth that the author had not typed.
 *
 * A line in the prompt is a request, and a model will honour it most of the
 * time. Most of the time is not good enough for something that goes out under
 * someone else's name, so the prompt asks and this makes sure.
 *
 * No env vars.
 */

/**
 * Em and en dashes become hyphens, spaced the way EAC writes them.
 *
 * An en dash is included because it is the same mistake in a narrower font -
 * nobody types one deliberately in prose, and where it does appear (a range
 * like 2020-2024) a hyphen is what house style wants anyway.
 *
 * A hyphen already inside a word is left alone. "Flesh-eating" is a word, not
 * a punctuation choice, and rewriting it would be a different bug.
 */
export function houseDashes(text: string): string {
  return String(text ?? '')
    // Horizontal whitespace only, never \s: a greedy \s* swallows the newline
    // before a dash that opens a line, joining that line to the one above it.
    .replace(/[ \t]*[—–][ \t]*/g, ' - ')
    // A dash opening a line is a bullet, not a sentence break.
    .replace(/^[ \t]*- /gm, '- ')
}

export interface StyledDraft {
  standfirst: string
  items: Array<{ question: string; answer: string }>
  editorNotes: string
}

/**
 * House style across a whole draft.
 *
 * editorNotes are left exactly as written. They are addressed to Cam, never
 * published, and tidying the punctuation of a note about punctuation helps
 * nobody.
 */
export function applyHouseStyle<T extends StyledDraft>(draft: T): T {
  return {
    ...draft,
    standfirst: houseDashes(draft.standfirst),
    items: (draft.items ?? []).map(i => ({
      ...i,
      question: houseDashes(i.question),
      answer:   houseDashes(i.answer),
    })),
  }
}
