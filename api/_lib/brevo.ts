/**
 * Shared Brevo helpers — contact list management + transactional email
 *
 * List IDs (Tools folder):
 *   book-canvas : 66
 *   idea-test   : 65
 *   unblocker   : 64
 *
 * Template IDs:
 *   book-canvas : 546
 *   idea-test   : 547
 *   unblocker   : 548
 */

export const BREVO_LISTS = {
  'book-canvas': 66,
  'idea-test':   65,
  'unblocker':   64,
} as const

export const BREVO_TEMPLATES = {
  'book-canvas': 546,
  'idea-test':   547,
  'unblocker':   548,
} as const

/**
 * Upsert a contact in Brevo and add them to the tool-specific list.
 * Best-effort — errors are logged but not re-thrown.
 */
export async function addContactToList(params: {
  email:      string
  firstName?: string
  tool:       keyof typeof BREVO_LISTS
  attributes?: Record<string, unknown>
}): Promise<void> {
  const { email, firstName, tool, attributes } = params
  const listId = BREVO_LISTS[tool]

  try {
    const res = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'accept':       'application/json',
        'content-type': 'application/json',
        'api-key':      process.env.BREVO_API_KEY!,
      },
      body: JSON.stringify({
        email,
        attributes: {
          FIRSTNAME: firstName || '',
          ...attributes,
        },
        listIds:       [listId],
        updateEnabled: true,
      }),
    })

    // 201 = created, 204 = updated — both are success
    if (res.status !== 201 && res.status !== 204) {
      const err = await res.json()
      console.error(`[brevo] addContactToList (${tool}) error:`, err)
    } else {
      console.log(`[brevo] contact added to list ${listId} (${tool})`)
    }
  } catch (err) {
    console.error(`[brevo] addContactToList (${tool}) failed:`, err)
  }
}

/**
 * Send a transactional email via a Brevo template.
 * Best-effort — errors are logged but not re-thrown.
 */
export async function sendResultsEmail(params: {
  to:         { email: string; name?: string }
  tool:       keyof typeof BREVO_TEMPLATES
  templateParams: Record<string, unknown>
}): Promise<void> {
  const { to, tool, templateParams } = params
  const templateId = BREVO_TEMPLATES[tool]

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept':       'application/json',
        'content-type': 'application/json',
        'api-key':      process.env.BREVO_API_KEY!,
      },
      body: JSON.stringify({
        to:         [{ email: to.email, name: to.name || to.email }],
        templateId,
        params:     templateParams,
      }),
    })

    if (!res.ok) {
      const err = await res.json()
      console.error(`[brevo] sendResultsEmail (${tool}) error:`, err)
    } else {
      console.log(`[brevo] results email sent (template ${templateId}) to ${to.email}`)
    }
  } catch (err) {
    console.error(`[brevo] sendResultsEmail (${tool}) failed:`, err)
  }
}
