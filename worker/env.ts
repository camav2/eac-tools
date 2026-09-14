/*
 * Tend worker — .env loader
 *
 * Ten lines instead of a dependency. Reads KEY=VALUE pairs from worker/.env
 * (or TEND_ENV_FILE) into process.env without overriding anything already
 * set, so a value exported in the shell still wins.
 */

import fs from 'node:fs'
import path from 'node:path'

export function loadEnv(file = process.env.TEND_ENV_FILE ?? path.resolve(process.cwd(), 'worker', '.env')): string[] {
  if (!fs.existsSync(file)) return []
  const loaded: string[] = []
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) {
      process.env[key] = value
      loaded.push(key)
    }
  }
  return loaded
}
