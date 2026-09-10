/*
 * The seven-day response deadline.
 *
 * Date maths that looks obviously right is where off-by-one lives, and this
 * one is read by an author in an email and then again on a calendar entry. The
 * two cases worth pinning are the timezone boundary (Vercel runs in UTC,
 * Melbourne does not) and the exclusive end date Google wants for an all-day
 * event.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEADLINE_DAYS,
  calendarUrl,
  dueDateFrom,
  formatDue,
  isOverdue,
} from '../api/_lib/qna-deadline'

test('is seven days out', () => {
  assert.equal(DEADLINE_DAYS, 7)
  // Midday Melbourne, nowhere near a date boundary anywhere.
  assert.equal(dueDateFrom(new Date('2026-09-10T02:00:00Z')), '2026-09-17')
})

test('counts from the Melbourne date, not the UTC one', () => {
  // 2026-09-10T23:00Z is already the 11th in Melbourne (UTC+10). Counting
  // from the UTC date would hand out the 17th and quietly rob a day.
  assert.equal(dueDateFrom(new Date('2026-09-10T23:00:00Z')), '2026-09-18')
})

test('rolls over month and year ends', () => {
  assert.equal(dueDateFrom(new Date('2026-09-28T02:00:00Z')), '2026-10-05')
  assert.equal(dueDateFrom(new Date('2026-12-29T02:00:00Z')), '2027-01-05')
})

test('survives the Melbourne daylight saving change', () => {
  // Clocks go forward on 4 October 2026. Adding seven 24-hour spans to a local
  // time lands an hour short and can drop a day; adding seven to a date can't.
  assert.equal(dueDateFrom(new Date('2026-09-30T02:00:00Z')), '2026-10-07')
})

test('handles a leap day', () => {
  assert.equal(dueDateFrom(new Date('2028-02-25T02:00:00Z')), '2028-03-03')
})

test('formats with the day name', () => {
  assert.equal(formatDue('2026-09-17'), 'Thursday 17 September')
})

test('formatting a junk date gives nothing rather than "Invalid Date"', () => {
  assert.equal(formatDue(''), '')
  assert.equal(formatDue('not-a-date'), '')
})

test('overdue only once the day has passed in Melbourne', () => {
  const due = '2026-09-17'
  assert.equal(isOverdue(due, new Date('2026-09-16T02:00:00Z')), false)
  // Still the 17th in Melbourne, so still not overdue.
  assert.equal(isOverdue(due, new Date('2026-09-17T12:00:00Z')), false)
  assert.equal(isOverdue(due, new Date('2026-09-18T02:00:00Z')), true)
})

test('calendar link is a one-day all-day event with an exclusive end', () => {
  const url = calendarUrl('2026-09-17', 'Seen Again', 'https://example.test/q?token=abc')
  // Google treats the end as exclusive: 17th to 18th is one day. Equal dates
  // produce a zero-length event some clients refuse to show.
  assert.match(url, /dates=20260917%2F20260918/)
  assert.match(url, /^https:\/\/calendar\.google\.com\/calendar\/render\?/)
  assert.match(url, /action=TEMPLATE/)
})

test('calendar link carries the book and the intake link', () => {
  const url = calendarUrl('2026-09-17', 'Seen Again', 'https://example.test/q?token=abc')
  const params = new URLSearchParams(url.split('?')[1])
  assert.match(params.get('text') ?? '', /Seen Again/)
  assert.match(params.get('details') ?? '', /https:\/\/example\.test\/q\?token=abc/)
})
