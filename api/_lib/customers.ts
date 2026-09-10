/*
 * Finding a member's email address.
 *
 * The Q&A pipeline knows an author by the name on their Webflow record and
 * nothing else — no email anywhere, and the People table in this base only
 * holds people who have used one of the free tools. Paying members live in a
 * different base: Sales (previously CUSTOMER) > Customers.
 *
 * This is a LOOKUP, not an authority. Everything it returns is shown on the
 * send screen for Cam to confirm before an email leaves, because the cost of a
 * wrong match is an author's unpublished interview landing in a stranger's
 * inbox. That is also why the matching below refuses to be clever.
 *
 * Env vars required:
 *   AIRTABLE_API_KEY  — must be scoped to the customers base as well as this one
 *   AIRTABLE_CUSTOMERS_BASE_ID, AIRTABLE_CUSTOMERS_TABLE_ID
 */

const CUSTOMERS_BASE  = process.env.AIRTABLE_CUSTOMERS_BASE_ID
const CUSTOMERS_TABLE = process.env.AIRTABLE_CUSTOMERS_TABLE_ID

export interface CustomerMatch {
  email: string
  name: string
  firstName: string
}

/**
 * Comparable form of a name.
 *
 * Case, punctuation and doubled spaces differ between the Webflow record and
 * the customer record often enough to matter; the person does not. Accents are
 * folded for the same reason.
 */
export function normaliseName(name: string): string {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // Apostrophes are dropped, not spaced. They join a name rather than break
    // it, so O'Brien has to land on the same key as OBrien; a hyphen is the
    // opposite case and does become a space, so Anne-Marie meets Anne Marie.
    .replace(/['‘’]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function atGet(path: string): Promise<any> {
  const url = `https://api.airtable.com/v0/${CUSTOMERS_BASE}/${CUSTOMERS_TABLE}${path}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Customers Airtable GET failed: ${res.status} ${body.slice(0, 200)}`)
  }
  return res.json()
}

/**
 * Every customer row, paged.
 *
 * The table runs to hundreds of rows, well past Airtable's 100-per-page limit,
 * so a single request would quietly match against only the first page and
 * report "not found" for everyone after it.
 */
async function allCustomers(): Promise<any[]> {
  const records: any[] = []
  let offset: string | undefined

  do {
    const qs = new URLSearchParams({ pageSize: '100' })
    qs.append('fields[]', 'Name')
    qs.append('fields[]', 'Firstname')
    qs.append('fields[]', 'Email')
    if (offset) qs.set('offset', offset)

    const data = await atGet(`?${qs}`)
    records.push(...(data.records ?? []))
    offset = data.offset
  } while (offset)

  return records
}

/**
 * The customer whose name matches, or null.
 *
 * Exact normalised match only. No nickname expansion, no surname-only
 * fallback, no "closest" scoring: a near miss here sends an author's
 * unpublished words to someone else, and an empty box that Cam fills in
 * himself costs him ten seconds. Ambiguity is treated as failure too — two
 * customers with the same name means this cannot know which, so it says so
 * rather than picking.
 */
export async function findCustomerByName(authorName: string): Promise<CustomerMatch | null> {
  if (!CUSTOMERS_BASE || !CUSTOMERS_TABLE) {
    console.warn('[customers] AIRTABLE_CUSTOMERS_BASE_ID/TABLE_ID not set — skipping lookup')
    return null
  }

  const wanted = normaliseName(authorName)
  if (!wanted) return null

  const matches = (await allCustomers()).filter(
    (r: any) => normaliseName(r.fields?.Name) === wanted && String(r.fields?.Email ?? '').trim()
  )

  if (matches.length !== 1) {
    console.log(
      `[customers] ${matches.length} matches for "${authorName}" — leaving the address blank`
    )
    return null
  }

  const f = matches[0].fields
  return {
    email:     String(f.Email).trim(),
    name:      String(f.Name ?? '').trim(),
    firstName: String(f.Firstname ?? '').trim(),
  }
}
