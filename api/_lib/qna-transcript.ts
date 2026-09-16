/*
 * Spoken answers: deciding whether a clean-up is still the author's answer.
 *
 * WHY SPOKEN ANSWERS ARE TREATED DIFFERENTLY FROM WRITTEN ONES
 * A typed answer is published verbatim because the author wrote it. A spoken
 * answer has no written form to protect: what sits in the field is Whisper's
 * transcription, complete with "chronologi- chronological" and a hundred ums.
 * Publishing that unedited is not fidelity to the author, it is fidelity to
 * the speech model. Nobody speaks in publishable prose and nobody should be
 * published as though they tried to.
 *
 * So spoken answers get transcribed properly: fillers, false starts and
 * interview scaffolding come out, sentence punctuation and paragraph breaks
 * go in, and everything else stays exactly as they said it.
 *
 * WHY THE GUARDS ARE HERE AND NOT IN THE PROMPT
 * The prompt asks. These check. The failure that matters is not a model that
 * refuses - it is a model that quietly writes a better answer than the author
 * gave, in words the author never used, under the author's name. That failure
 * is invisible in the output and obvious in the arithmetic, which is what
 * these functions measure.
 *
 * No env vars, no network - all of this is testable without either.
 */

/** A response is spoken when it has a transcript and no typed answer. */
export function isSpoken(response: { text?: string; transcript?: string } | null | undefined): boolean {
  return Boolean(
    !String(response?.text ?? '').trim() && String(response?.transcript ?? '').trim()
  )
}

/** Words, ignoring punctuation and case, for comparing two versions of one answer. */
export function words(text: string): string[] {
  return String(text ?? '')
    .toLowerCase()
    // Keep intra-word apostrophes and hyphens: "didn't" and "flesh-eating" are
    // one word each, and splitting them would report false novelties.
    .replace(/[^a-z0-9'\-\s]/g, ' ')
    .split(/\s+/)
    .map(w => w.replace(/^['-]+|['-]+$/g, ''))
    .filter(Boolean)
}

export function wordCount(text: string): number {
  return words(text).length
}

/**
 * Words in the clean-up that the author never said.
 *
 * A clean-up only removes and punctuates, so in the ideal case its vocabulary
 * is a strict subset of the transcript's. It never quite is - a false start
 * repaired ("there was" to "there were") or a contraction expanded introduces
 * a word - and that is fine and small. What this catches is the other thing:
 * a paragraph of fluent prose the author did not speak, which shows up as a
 * long list here and as nothing at all to the naked eye.
 */
export function novelWords(original: string, cleaned: string): string[] {
  const had = new Set(words(original))
  const seen = new Set<string>()
  return words(cleaned).filter(w => {
    if (had.has(w) || seen.has(w)) return false
    seen.add(w)
    return true
  })
}

/**
 * Filler the clean-up was supposed to remove and did not.
 *
 * Standalone only. "um" inside "umbrella" is not filler, and an author who
 * says "er" as a word deserves the same care as one who does not.
 */
export function residualFillers(text: string): string[] {
  const FILLERS = ['um', 'uh', 'erm', 'ah', 'mmm', 'hmm']
  const found = new Set<string>()
  for (const w of words(text)) if (FILLERS.includes(w)) found.add(w)
  return [...found]
}

/**
 * How much new vocabulary is too much.
 *
 * A repaired false start or two lands under 1%. A rewrite - the model
 * answering the question in its own words - runs well into double figures.
 * Five is comfortably clear of honest repair and nowhere near a rewrite.
 */
export const NOVEL_WORD_LIMIT = 0.05

export interface CleanCheck {
  accepted: boolean
  reason: string
  novel: string[]
  fillers: string[]
  originalWords: number
  cleanedWords: number
}

/**
 * Whether a cleaned answer may stand in for what the author said.
 *
 * Rejection falls back to the raw transcript rather than failing the draft:
 * an ugly answer in the author's own words is always publishable after Cam
 * reads it, and a fluent one in somebody else's words is not.
 */
export function checkClean(original: string, cleaned: string): CleanCheck {
  const originalWords = wordCount(original)
  const cleanedWords = wordCount(cleaned)
  const novel = novelWords(original, cleaned)
  const fillers = residualFillers(cleaned)
  const base: Omit<CleanCheck, 'accepted' | 'reason'> = {
    novel, fillers, originalWords, cleanedWords,
  }

  if (!cleaned.trim()) {
    return { ...base, accepted: false, reason: 'the clean-up came back empty' }
  }

  // Removing and punctuating cannot add words. Growth means prose was written.
  if (cleanedWords > originalWords) {
    return {
      ...base,
      accepted: false,
      reason: `the clean-up is longer than what was said (${cleanedWords} words against ${originalWords})`,
    }
  }

  // An answer cut to a fraction of its length has had content removed, not
  // filler. Kerryn's transcripts lose roughly a quarter; half is a different
  // operation wearing the same name.
  if (originalWords > 0 && cleanedWords < originalWords * 0.4) {
    return {
      ...base,
      accepted: false,
      reason: `the clean-up dropped more than half of what was said (${cleanedWords} words from ${originalWords})`,
    }
  }

  if (cleanedWords > 0 && novel.length > cleanedWords * NOVEL_WORD_LIMIT) {
    return {
      ...base,
      accepted: false,
      reason:
        `the clean-up introduced ${novel.length} words the author did not say ` +
        `(${novel.slice(0, 8).join(', ')})`,
    }
  }

  return { ...base, accepted: true, reason: '' }
}

/**
 * The line Cam reads under a spoken answer on the draft screen.
 *
 * Says what happened in words rather than leaving him to infer it from a
 * diff. A clean-up that was rejected has to announce itself - silently
 * publishing the raw transcript would look identical to a clean-up that
 * decided nothing needed doing.
 */
export function cleanSummary(check: CleanCheck): string {
  if (!check.accepted) {
    return `Spoken. Clean-up rejected, showing the raw transcript: ${check.reason}.`
  }
  const cut = check.originalWords - check.cleanedWords
  const bits = [`Spoken. Cleaned: ${cut} words of filler and false starts removed`]
  if (check.novel.length) bits.push(`${check.novel.length} word(s) not in the recording: ${check.novel.join(', ')}`)
  if (check.fillers.length) bits.push(`filler still present: ${check.fillers.join(', ')}`)
  return bits.join('. ') + '.'
}
