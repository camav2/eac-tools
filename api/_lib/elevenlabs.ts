/*
 * ElevenLabs Scribe — speech-to-text for author audio responses.
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
 */

const STT_ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text'
const MODEL_ID = 'scribe_v1'

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
