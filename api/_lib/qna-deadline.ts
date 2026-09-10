/*
 * The response deadline.
 *
 * A fortnight from the day the invitation goes out. Lives here rather than in
 * the two places that need it, because the date in the email and the date on
 * the page have to be the same date — an author told "by Tuesday" who then
 * sees "by Wednesday" stops trusting both.
 *
 * A plain calendar date, never a timestamp. "By the 17th" is what a person
 * means by a deadline; attaching 14:32:07 to it invents a precision nobody
 * asked for and makes the all-day calendar entry wrong.
 *
 * No env vars required.
 */

export const DEADLINE_DAYS = 14

/**
 * Melbourne, regardless of where the function happens to run.
 *
 * Vercel runs in UTC. Late on a Melbourne evening that is still yesterday in
 * UTC, so a naive computation would quietly hand out a deadline a day early
 * for any invite sent after about 10am UTC.
 */
const TIMEZONE = 'Australia/Melbourne'

/** The Y-M-D showing on a Melbourne calendar at that instant. */
function melbourneParts(at: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at)

  const get = (t: string) => Number(parts.find(p => p.type === t)?.value)
  return { y: get('year'), m: get('month'), d: get('day') }
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * The due date, as YYYY-MM-DD.
 *
 * Day arithmetic is done in UTC on the date parts alone. Adding seven
 * twenty-four hour spans to a local time lands an hour out across a daylight
 * saving boundary, which Melbourne crosses twice a year; adding seven to a
 * date cannot.
 */
export function dueDateFrom(sentAt: Date = new Date(), days = DEADLINE_DAYS): string {
  const { y, m, d } = melbourneParts(sentAt)
  const shifted = new Date(Date.UTC(y, m - 1, d + days))
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

/** "Tuesday 17 September" — the day name is what makes a date feel near. */
export function formatDue(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  if (!y || !m || !d) return ''
  return new Intl.DateTimeFormat('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)))
}

/** True once the due date is behind us, in Melbourne. */
export function isOverdue(isoDate: string, now: Date = new Date()): boolean {
  const { y, m, d } = melbourneParts(now)
  return isoDate < `${y}-${pad(m)}-${pad(d)}`
}

/**
 * A Google Calendar "add event" link for an all-day entry on the due date.
 *
 * Google takes an exclusive end date for all-day events, so a one-day entry
 * runs from the due date to the day after. Getting that wrong shows a
 * zero-length event that some clients then refuse to display at all.
 *
 * Chosen over a downloadable .ics because it is a plain link that works from
 * an email on a phone, where a file download is where good intentions go to
 * die.
 */
export function calendarUrl(isoDate: string, bookTitle: string, intakeLink: string): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  const start = new Date(Date.UTC(y, m - 1, d))
  const end   = new Date(Date.UTC(y, m - 1, d + 1))
  const stamp = (dt: Date) =>
    `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}`

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text:   `Answer the EAC interview questions about ${bookTitle}`,
    dates:  `${stamp(start)}/${stamp(end)}`,
    details:
      `Your questions are here:\n${intakeLink}\n\n` +
      `Type your answers or record them out loud. Everything saves as you go.`,
  })

  return `https://calendar.google.com/calendar/render?${params}`
}
