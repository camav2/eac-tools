/*
 * The "we have it" email, sent the moment an author submits.
 *
 * An author has just spent an hour on six questions and clicked a button.
 * Without this, the only thing telling them it worked is a page they are
 * about to close. The email is the receipt, and the link in it is the proof:
 * it opens the same page they submitted from, now showing their questions,
 * their answers and their own recordings back to them.
 *
 * Best-effort by design. A submission is saved before this is attempted and
 * a failure here is logged and swallowed, because an author whose answers
 * are safely stored must never see an error implying they are not.
 *
 * Written in the same plain shape as the invitation: a <div> per line, a
 * <div><br></div> for the gap. That is what Gmail produces when a person
 * types, and the Gmail helper rewrites <p> but leaves <div> alone.
 *
 * Env vars required: SUPABASE_URL, SUPABASE_SERVICE_KEY,
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 */

import { sendViaGmailAddress } from './gmail'

const FROM_ADDRESS = 'cameron@expertauthor.community'
const CC_ADDRESS   = 'hello@expertauthor.community'
const INTAKE_BASE_URL = 'https://hub.expertauthor.community/qna-intake'

function firstName(full: string): string {
  return String(full || '').trim().split(/\s+/)[0] || 'there'
}

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function lines(...parts: string[]): string {
  return parts
    .map(t => (t === '' ? '<div><br></div>' : `<div>${t}</div>`))
    .join('\n')
}

export function receiptEmail(authorName: string, bookTitle: string, link: string) {
  return {
    subject: `Got them - thanks for the answers about ${bookTitle}`,
    body: lines(
      `Hi ${esc(firstName(authorName))},`,
      '',
      `Your answers have come through. Thank you for taking the time.`,
      '',
      `You can read back everything you sent us here:`,
      `<a href="${esc(link)}">${esc(link)}</a>`,
      '',
      `Next, we shape it into an edited Q&amp;A. You will see that before anyone else does - nothing gets published without your approval.`,
      '',
      `If you have thought of something since, or want to change an answer, just reply to this email.`,
      '',
      `Thanks again.`,
      '',
      `Cameron`,
    ),
  }
}

/**
 * Sends the receipt. Never throws.
 *
 * Returns what happened so the caller can log it, rather than a bare boolean:
 * "no address on the row" is an ordinary state for a link Cam pasted by hand,
 * and worth telling apart from a send that actually failed.
 */
export async function sendReceipt(opts: {
  to: string
  authorName: string
  bookTitle: string
  token: string
}): Promise<'sent' | 'no-address' | 'failed'> {
  if (!opts.to?.trim()) return 'no-address'

  const link = `${INTAKE_BASE_URL}?token=${encodeURIComponent(opts.token)}`
  const { subject, body } = receiptEmail(opts.authorName, opts.bookTitle, link)

  try {
    await sendViaGmailAddress(
      FROM_ADDRESS, opts.to.trim(), subject, body,
      undefined, opts.authorName, CC_ADDRESS,
    )
    return 'sent'
  } catch (err) {
    console.error('[qna-receipt] send failed:', err)
    return 'failed'
  }
}
