/*
 * Word-level diff between what an author said and what the edit made of it.
 *
 * This exists so Cam can see every cut before he approves one. The draft
 * screen used to show the edited version alone, which meant approving changes
 * to someone else's words without being shown what had changed.
 *
 * Server-side rather than in the page so it can be tested. The failure that
 * matters is silent: a diff that under-reports makes a heavy edit look light,
 * which is worse than no diff at all because it looks like reassurance.
 *
 * No env vars.
 */

/**
 * Words and the whitespace between them, as separate tokens.
 *
 * Splitting on whitespace alone would lose the author's paragraph breaks, and
 * those carry meaning - a break is where they stopped to think.
 */
function tokenise(text: string): string[] {
  return String(text ?? '').split(/(\s+)/).filter(t => t !== '')
}

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Whitespace runs are carried through unmarked; only words count as changes. */
function isGap(token: string): boolean {
  return /^\s+$/.test(token)
}

/**
 * Longest common subsequence over tokens, as a table of match lengths.
 *
 * Capped because this is O(n*m) in both time and memory: two 3000-word answers
 * would be nine million cells for a diff nobody would read anyway. Past the
 * cap the caller shows both sides unmarked, which is honest - it says "too
 * long to compare" rather than "nothing changed".
 */
const MAX_TOKENS = 4000

interface DiffPart { text: string; changed: boolean }

function diffTokens(a: string[], b: string[]): { left: DiffPart[]; right: DiffPart[] } {
  const n = a.length, m = b.length
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  const left: DiffPart[] = []
  const right: DiffPart[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      left.push({ text: a[i], changed: false })
      right.push({ text: b[j], changed: false })
      i++; j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      left.push({ text: a[i], changed: !isGap(a[i]) })
      i++
    } else {
      right.push({ text: b[j], changed: !isGap(b[j]) })
      j++
    }
  }
  while (i < n) { left.push({ text: a[i], changed: !isGap(a[i]) }); i++ }
  while (j < m) { right.push({ text: b[j], changed: !isGap(b[j]) }); j++ }

  return { left, right }
}

function render(parts: DiffPart[], cls: string): string {
  return parts
    .map(p => (p.changed ? `<mark class="${cls}">${esc(p.text)}</mark>` : esc(p.text)))
    .join('')
}

export interface DiffResult {
  /** The author's words, with anything the edit dropped marked. */
  originalHtml: string
  /** The edit, with anything not in the original marked. */
  editedHtml: string
  /** Words of theirs the edit dropped. */
  removed: number
  /** Words in the edit that were not theirs. */
  added: number
  /** True when the two are too long to compare and both are shown plain. */
  tooLong: boolean
}

export function wordDiff(original: string, edited: string): DiffResult {
  const a = tokenise(original)
  const b = tokenise(edited)

  if (a.length + b.length > MAX_TOKENS) {
    return {
      originalHtml: esc(original),
      editedHtml:   esc(edited),
      removed: 0, added: 0, tooLong: true,
    }
  }

  const { left, right } = diffTokens(a, b)
  return {
    originalHtml: render(left, 'diff-cut'),
    editedHtml:   render(right, 'diff-new'),
    removed: left.filter(p => p.changed).length,
    added:   right.filter(p => p.changed).length,
    tooLong: false,
  }
}

/**
 * The author's own words for one answer.
 *
 * A spoken answer's transcript is what the editor was given, so that is what
 * the edit has to be compared against. Comparing against nothing, for an
 * answer that was only ever spoken, would show the whole edit as invented.
 */
export function sourceText(answer: { text?: string; transcript?: string }): string {
  const typed = String(answer?.text ?? '').trim()
  const spoken = String(answer?.transcript ?? '').trim()
  if (typed && spoken) return `${typed}\n\n${spoken}`
  return typed || spoken
}
