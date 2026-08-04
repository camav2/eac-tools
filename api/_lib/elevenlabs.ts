/*
 * ElevenLabs — speech-to-text for author responses, and text-to-speech for
 * Kelly's voiced intro and questions on the intake page.
 *
 * Transcription runs server-side, triggered from the admin review screen —
 * never on the intake page. The author records, uploads and leaves; they
 * should not sit watching a progress bar for something they don't need to see.
 *
 * The direct-upload endpoint is synchronous, which is fine at our file sizes
 * (the intake page caps recordings well under the limit). The calling handler
 * raises its maxDuration to cover a long clip.
 *
 * Env vars required: ELEVENLABS_API_KEY
 *                    ELEVENLABS_VOICE_ID (Kelly's cloned voice, for TTS)
 */

const STT_ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text'
const TTS_ENDPOINT = 'https://api.elevenlabs.io/v1/text-to-speech'
const VOICES_ENDPOINT = 'https://api.elevenlabs.io/v1/voices'
const MODEL_ID = 'scribe_v1'
// Multilingual v2 is the higher-quality option and this is pre-generated, not
// realtime, so latency doesn't matter — quality does.
const TTS_MODEL_ID = 'eleven_multilingual_v2'

export interface Transcript {
  text: string
  languageCode?: string
}

/**
 * `filename` must carry a real extension (.webm / .m4a / …). Scribe uses it to
 * identify the container format — an extensionless file is accepted with a
 * 200 and transcribes to an empty string rather than erroring, which is a
 * genuinely confusing failure to debug.
 */
export async function transcribeAudio(
  buffer: Buffer,
  contentType: string,
  filename = 'answer.webm'
): Promise<Transcript> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(buffer)], { type: contentType }), filename)
  form.append('model_id', MODEL_ID)
  // Author monologue — no diarization needed, and it keeps the response small.
  form.append('diarize', 'false')

  const res = await fetch(STT_ENDPOINT, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY! },
    body: form,
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`ElevenLabs STT ${res.status}: ${body.slice(0, 300)}`)
  }

  const data = await res.json()
  if (typeof data.text !== 'string') {
    throw new Error('ElevenLabs STT returned no text field')
  }
  // Treat empty text as a failure, not a result. Saving "" looks identical to
  // "never transcribed" in the admin UI, so the operator sees the button reset
  // with no explanation and no way to tell the two apart.
  if (!data.text.trim()) {
    throw new Error(
      'Transcription came back empty — the recording may be silent, or the audio format was not recognised.'
    )
  }
  return { text: data.text, languageCode: data.language_code }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Text to speech — Kelly reading the intake page
 * ──────────────────────────────────────────────────────────────────────────*/

export interface VoiceOption {
  voiceId: string
  name: string
  category?: string
}

/** Lists the account's voices so the right voice ID can be identified without
 *  leaving the admin screen. */
export async function listVoices(): Promise<VoiceOption[]> {
  const res = await fetch(VOICES_ENDPOINT, {
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY! },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`ElevenLabs voices ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  return (data.voices ?? []).map((v: any) => ({
    voiceId:  v.voice_id,
    name:     v.name,
    category: v.category,
  }))
}

// Resolved once per warm invocation — the voice list doesn't change mid-run,
// and re-fetching it before each of seven clips is wasted latency.
let cachedVoiceId: string | null = null

/**
 * Finds Kelly's voice in the account by name, so there's no ID to look up or
 * env var to keep in sync. ELEVENLABS_VOICE_ID overrides it when a specific
 * voice is wanted (e.g. two voices with similar names).
 */
export async function resolveVoiceId(): Promise<string> {
  if (process.env.ELEVENLABS_VOICE_ID) return process.env.ELEVENLABS_VOICE_ID
  if (cachedVoiceId) return cachedVoiceId

  const voices = await listVoices()
  const match =
    voices.find(v => /kelly\s*irving/i.test(v.name)) ??
    voices.find(v => /kelly/i.test(v.name))

  if (!match) {
    const names = voices.map(v => v.name).join(', ') || '(none)'
    throw new Error(
      `No voice matching "Kelly" found in the ElevenLabs account. Available: ${names}. ` +
      `Set ELEVENLABS_VOICE_ID to pick one explicitly.`
    )
  }
  cachedVoiceId = match.voiceId
  return match.voiceId
}

/**
 * Renders text to MP3 in Kelly's voice. Returns raw audio bytes — the caller
 * decides where to store them.
 *
 * Deliberately pre-generated and cached rather than synthesised per page load:
 * TTS on every visit would be slow for the author, and would bill a fresh
 * generation every time someone refreshed the page.
 */
export async function textToSpeech(text: string, voiceId?: string): Promise<Buffer> {
  const voice = voiceId || await resolveVoiceId()
  if (!text.trim()) throw new Error('Nothing to speak')

  const res = await fetch(`${TTS_ENDPOINT}/${encodeURIComponent(voice)}`, {
    method: 'POST',
    headers: {
      'xi-api-key':  process.env.ELEVENLABS_API_KEY!,
      'Content-Type': 'application/json',
      Accept:         'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: TTS_MODEL_ID,
      voice_settings: {
        // Warm and human rather than flat newsreader: a little style, and
        // stability low enough to keep natural variation across a long read.
        stability:         0.45,
        similarity_boost:  0.8,
        style:             0.25,
        use_speaker_boost: true,
      },
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`ElevenLabs TTS ${res.status}: ${body.slice(0, 300)}`)
  }

  const arrayBuffer = await res.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  if (!buffer.length) throw new Error('ElevenLabs TTS returned empty audio')
  return buffer
}
