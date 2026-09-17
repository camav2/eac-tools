/*
 * Spoken answers: deciding whether an edit is still the author's answer.
 *
 * WHY SPOKEN ANSWERS ARE TREATED DIFFERENTLY FROM WRITTEN ONES
 * A typed answer is published verbatim because the author wrote it. A spoken
 * answer has no written form to protect: what sits in the field is Whisper's
 * transcription, complete with "chronologi- chronological" and a hundred ums.
 * Publishing that unedited is not fidelity to the author, it is fidelity to
 * the speech model.
 *
 * WRITTEN, NOT TRANSCRIBED
 * The first version of this cleaned a transcript and kept the spoken register:
 * fillers out, everything else as she said it. Kerryn Harvey read her published
 * interview and said it came across as too bogan. She was right, and the
 * principle this file exists for - honour the author, not the transcript - is
 * exactly what put her judgement ahead of ours. Nobody who sits down to write
 * an answer writes "so much more deep" or "I think that's probably what I took
 * away from all that". A magazine interview is the author on the page, and the
 * page is written.
 *
 * So a spoken answer is now edited into written form: grammar fixed, repetition
 * collapsed, verbal tics gone. What stays is what makes it hers - her stories,
 * her details, her images, her order of thought, her warmth.
 *
 * WHY THE GUARDS COUNT CONTENT WORDS
 * The prompt asks. These check. The failure that matters is a model that
 * quietly writes a better answer than the author gave, in words the author
 * never used, under the author's name.
 *
 * The first guard counted every new word, and on a written edit that measures
 * the wrong thing. Repairing speech into prose needs grammar words the speaker
 * did not happen to say - from, could, weren't, are - and those were eating the
 * whole budget. A properly polished answer would have tipped over it, been
 * rejected, and fallen back to the raw transcript: the most bogan version
 * there is, published by the guard meant to protect her.
 *
 * Invention lives in content words - nouns, verbs, adjectives, the claims and
 * images. Measured on Kerryn's real answers, an honest written edit introduces
 * about 3% new content words and a fluent rewrite introduces 88%. Counting
 * content words turns a knife-edge into a canyon.
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
    // Curly apostrophes become straight ones first, or "don't" typed on a phone
    // and "don't" from the transcriber count as two different words.
    .replace(/[‘’]/g, "'")
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
 * The words that carry grammar rather than meaning.
 *
 * A written edit of speech needs these freely - turning "there was any real
 * surprises" into "there weren't any real surprises" adds "weren't", and that
 * is repair, not invention. Anything not in this list is a content word, and a
 * content word the author did not say is worth counting.
 *
 * Deliberately generous. Leaving a function word out makes the guard noisier;
 * putting a content word in makes it blind to invention. The first is the
 * cheaper mistake.
 */
const FUNCTION_WORDS = new Set(`
  a about above after again against all almost also although always am among an and
  another any anyone anything are aren't around as at away back be became because become
  been before being below between both but by can can't cannot could couldn't did didn't
  do does doesn't doing don't done down during each either else enough even ever every
  everyone everything few for from further get gets getting got had hadn't has hasn't have
  haven't having he he'd he'll he's her here here's hers herself him himself his how how's
  however i i'd i'll i'm i've if in instead into is isn't it it's its itself just least
  less let let's lot lots made make makes many may me might more most much must mustn't
  my myself neither never no none nor not nothing now of off often on once one ones only
  onto or other others otherwise ought our ours ourselves out over own perhaps quite
  rather really same shall shan't she she'd she'll she's should shouldn't since so some
  someone something sometimes still such than that that's the their theirs them
  themselves then there there's these they they'd they'll they're they've thing things
  this those though through thus to together too toward towards under unless until up
  upon us very via was wasn't way we we'd we'll we're we've well were weren't what what's
  whatever when when's where where's whether which while who who's whole whom whose why
  why's will with within without won't would wouldn't yet you you'd you'll you're you've
  your yours yourself yourselves
`.split(/\s+/).filter(Boolean))

/** Words that carry meaning. Numbers are left out: a year is a fact, not a word choice. */
export function contentWords(text: string): string[] {
  return words(text).filter(w => !FUNCTION_WORDS.has(w) && !/^\d+$/.test(w))
}

/**
 * Every word in the edit the author never said, content or not.
 *
 * Kept for the tests and for anyone curious, but not what the guard measures.
 * See contentWords for why.
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
 * Content words in the edit that the author never said.
 *
 * This is the list Cam reads, and the number the guard judges. A novel content
 * word is either a legitimate repair ("so much more deep" becoming "deeper")
 * or an invention. The guard catches invention in bulk; this list is how a
 * single invented word - "yakka", added to Kerryn's answer by the first
 * version of this - gets seen by a person instead of slipping under a
 * percentage.
 */
export function novelContentWords(original: string, cleaned: string): string[] {
  const had = new Set(words(original))
  const seen = new Set<string>()
  return contentWords(cleaned).filter(w => {
    if (had.has(w) || seen.has(w)) return false
    seen.add(w)
    return true
  })
}

/**
 * Filler the edit was supposed to remove and did not.
 *
 * Standalone only. "um" inside "umbrella" is not filler.
 */
export function residualFillers(text: string): string[] {
  const FILLERS = ['um', 'uh', 'erm', 'ah', 'mmm', 'hmm']
  const found = new Set<string>()
  for (const w of words(text)) if (FILLERS.includes(w)) found.add(w)
  return [...found]
}

/**
 * Spoken tics that make a written answer read as a transcript.
 *
 * These are what "too bogan" was made of. Reported, never rejected: "a
 * different kind of book" is a perfectly good sentence and a phrase list
 * cannot tell it from a verbal habit. The point is to put it in front of
 * Cam when an edit did not go far enough.
 */
export function residualTics(text: string): string[] {
  const TICS = ['so yeah', 'i reckon', 'i guess', 'you know', 'i mean', 'kind of', 'sort of', 'kinda', 'sorta']
  const flat = ' ' + words(text).join(' ') + ' '
  return TICS.filter(t => flat.includes(' ' + t + ' '))
}

/**
 * How much new meaning is too much.
 *
 * Measured on Kerryn's answers: an honest written edit introduces 2.6% to
 * 3.3% new content words; a fluent rewrite in somebody else's words introduces
 * 88%. Fifteen leaves a written edit plenty of room to repair grammar and
 * still sits nowhere near a rewrite.
 */
export const NOVEL_CONTENT_LIMIT = 0.15

/**
 * The fewest new content words an edit is always allowed, however short.
 *
 * A percentage alone is wrong at small sizes. An eight-word answer has perhaps
 * four content words, so one honest repair - "deep" to "deeper" - is 25% and
 * would be rejected, dropping the answer back to its raw transcript. That is
 * the failure this guard was rebuilt to remove, reappearing at the short end.
 * A rewrite of a short answer replaces most of its words, so it still fails.
 */
export const MIN_NOVEL_ALLOWANCE = 2

/**
 * The most an edit may cut before it is removing what they said rather than
 * how they said it.
 *
 * Speech repeats itself and circles back before landing a point, so a written
 * version of it is legitimately much shorter: Kerryn's written answers come in
 * 40-45% under her transcripts. Past about two thirds, content is going.
 */
export const MIN_KEPT_SHARE = 0.35

export interface CleanCheck {
  accepted: boolean
  reason: string
  /** Content words not in the recording - the list Cam reads. */
  novel: string[]
  fillers: string[]
  tics: string[]
  originalWords: number
  cleanedWords: number
}

/**
 * Whether an edited answer may stand in for what the author said.
 *
 * Rejection falls back to the raw transcript rather than failing the draft:
 * an ugly answer in the author's own words is always publishable after Cam
 * reads it, and a fluent one in somebody else's words is not.
 */
export function checkClean(original: string, cleaned: string): CleanCheck {
  const originalWords = wordCount(original)
  const cleanedWords = wordCount(cleaned)
  const novel = novelContentWords(original, cleaned)
  const fillers = residualFillers(cleaned)
  const tics = residualTics(cleaned)
  const base: Omit<CleanCheck, 'accepted' | 'reason'> = {
    novel, fillers, tics, originalWords, cleanedWords,
  }

  if (!cleaned.trim()) {
    return { ...base, accepted: false, reason: 'the edit came back empty' }
  }

  // Tightening speech into prose cannot add words. Growth means prose was written.
  if (cleanedWords > originalWords) {
    return {
      ...base,
      accepted: false,
      reason: `the edit is longer than what was said (${cleanedWords} words against ${originalWords})`,
    }
  }

  if (originalWords > 0 && cleanedWords < originalWords * MIN_KEPT_SHARE) {
    return {
      ...base,
      accepted: false,
      reason:
        `the edit kept less than a third of what was said (${cleanedWords} words from ` +
        `${originalWords}), which is content going rather than repetition`,
    }
  }

  const content = contentWords(cleaned).length
  const allowance = Math.max(MIN_NOVEL_ALLOWANCE, content * NOVEL_CONTENT_LIMIT)
  if (content > 0 && novel.length > allowance) {
    return {
      ...base,
      accepted: false,
      reason:
        `the edit introduced ${novel.length} words of meaning the author did not say ` +
        `(${novel.slice(0, 8).join(', ')})`,
    }
  }

  return { ...base, accepted: true, reason: '' }
}

/**
 * The line Cam reads under a spoken answer on the draft screen.
 *
 * A rejected edit has to announce itself: silently publishing the raw
 * transcript would look identical to an edit that found nothing to do.
 */
export function cleanSummary(check: CleanCheck): string {
  if (!check.accepted) {
    return `Spoken. Edit rejected, showing the raw transcript: ${check.reason}.`
  }
  const cut = check.originalWords - check.cleanedWords
  const bits = [`Spoken. Edited into written form, ${cut} words shorter`]
  if (check.novel.length) bits.push(`words not in the recording: ${check.novel.join(', ')}`)
  if (check.tics.length) bits.push(`still reads as speech: ${check.tics.join(', ')}`)
  if (check.fillers.length) bits.push(`filler still present: ${check.fillers.join(', ')}`)
  return bits.join('. ') + '.'
}
