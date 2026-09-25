import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export interface Config {
  apiUrl: string
  token?: string
  model?: string
  provider?: string
}

const CONFIG_DIR = join(homedir(), '.loop-code')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

const DEFAULTS: Config = {
  apiUrl: process.env.LOOP_GPT_URL || 'https://api.loop-gpt.cyou',
  token: process.env.LOOP_GPT_TOKEN,
  model: process.env.LOOP_GPT_MODEL,
  provider: process.env.LOOP_GPT_PROVIDER || 'hf',
}

export function loadConfig(): Config {
  let stored: Partial<Config> = {}
  if (existsSync(CONFIG_FILE)) {
    try { stored = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) } catch {}
  }
  return { ...DEFAULTS, ...stored }
}

export function saveConfig(updates: Partial<Config>): void {
  let existing: Partial<Config> = {}
  if (existsSync(CONFIG_FILE)) {
    try { existing = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) } catch {}
  }
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify({ ...existing, ...updates }, null, 2))
}
