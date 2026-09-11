/*
 * The tool registry.
 *
 * Which tools are `write` is the whole approval story. If someone adds a
 * tool that sends, posts or records and forgets the flag, it runs unattended
 * and nothing in the UI says so. So the write set is pinned by name, and
 * every entry is checked for the shape the model and the picker rely on.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { TOOLS, getTool, toolDefsFor, toolCatalogue } from '../api/_lib/tend-tools'

test('exactly these tools change the outside world', () => {
  const writes = TOOLS.filter(t => t.write).map(t => t.name).sort()
  assert.deepEqual(writes, ['airtable_log_activity', 'brevo_add_contact', 'send_email'])
})

test('every tool has a unique name, a label, a description and an object schema', () => {
  const names = TOOLS.map(t => t.name)
  assert.equal(new Set(names).size, names.length, 'names are unique')
  for (const t of TOOLS) {
    assert.ok(t.label, `${t.name} label`)
    assert.ok(t.description.length > 20, `${t.name} description is meaningful`)
    assert.equal((t.input_schema as any).type, 'object', `${t.name} schema is an object`)
    assert.equal(typeof t.run, 'function')
  }
})

test('write tools that take a recipient require it in the schema', () => {
  const email = getTool('send_email')!
  assert.deepEqual((email.input_schema as any).required, ['to', 'subject', 'html'])
  const brevo = getTool('brevo_add_contact')!
  assert.ok((brevo.input_schema as any).required.includes('email'))
})

test('toolDefsFor keeps only known names, in the order asked', () => {
  const defs = toolDefsFor(['fetch_webpage', 'ghost', 'send_email'])
  assert.deepEqual(defs.map(d => d.name), ['fetch_webpage', 'send_email'])
  for (const d of defs) {
    assert.deepEqual(Object.keys(d).sort(), ['description', 'input_schema', 'name'], 'exactly the fields the API wants')
  }
  assert.deepEqual(toolDefsFor([]), [])
})

test('the catalogue exposes write flags and nothing executable', () => {
  const cat = toolCatalogue()
  assert.equal(cat.length, TOOLS.length)
  for (const c of cat) {
    assert.deepEqual(Object.keys(c).sort(), ['description', 'label', 'name', 'write'])
    assert.equal(typeof c.write, 'boolean')
  }
  assert.equal(cat.find(c => c.name === 'send_email')?.write, true)
  assert.equal(cat.find(c => c.name === 'circle_list_members')?.write, false)
})

test('send_email refuses to run with no admin mailbox rather than sending as nobody', async () => {
  const email = getTool('send_email')!
  await assert.rejects(
    () => email.run({ to: 'a@b.c', subject: 's', html: '<p>x</p>' }, { adminEmail: '' }),
    /No admin mailbox is connected/,
  )
})
