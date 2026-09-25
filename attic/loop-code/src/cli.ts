#!/usr/bin/env node
/**
 * Loop Code — local agentic CLI for Loop GPT.
 *
 * Usage:
 *   loop-code                    # interactive REPL
 *   loop-code "fix the tests"    # single task
 *   loop-code --login            # save API token
 *   loop-code --url <url>        # set API URL
 *   loop-code --status           # show config
 */
import * as readline from 'readline'
import { loadConfig, saveConfig } from './config.js'
import { runAgentLoop, type LLMMessage } from './llm.js'

// Use dynamic chalk import to handle ESM
let chalk: any
async function getChalk() {
  if (!chalk) chalk = (await import('chalk')).default
  return chalk
}

const VERSION = '0.1.0'

async function main() {
  const c = await getChalk()
  const args = process.argv.slice(2)

  // --help
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
${c.bold.hex('#c96442')('Loop Code')} v${VERSION} — local agentic CLI powered by Loop GPT

${c.bold('Usage:')}
  loop-code                    Interactive session (REPL)
  loop-code "your task"        Run a single task
  loop-code --login            Authenticate (save API token)
  loop-code --url <url>        Set Loop GPT API URL
  loop-code --model <model>    Set model name
  loop-code --status           Show current config

${c.bold('Environment:')}
  LOOP_GPT_URL       Loop GPT backend URL (default: https://api.loop-gpt.cyou)
  LOOP_GPT_TOKEN     API token (or use --login)
  LOOP_GPT_MODEL     Model name override

${c.bold('Examples:')}
  loop-code "run the tests and fix any failures"
  loop-code "add a /health endpoint to the Express backend"
  loop-code "find all TODO comments in src/"
  loop-code "deploy to Railway using the CLI"
`)
    process.exit(0)
  }

  // --login
  if (args.includes('--login')) {
    await doLogin(c)
    return
  }

  // --url <url>
  const urlIdx = args.indexOf('--url')
  if (urlIdx !== -1 && args[urlIdx + 1]) {
    saveConfig({ apiUrl: args[urlIdx + 1] })
    console.log(c.green(`✓ API URL saved: ${args[urlIdx + 1]}`))
    return
  }

  // --model <model>
  const modelIdx = args.indexOf('--model')
  if (modelIdx !== -1 && args[modelIdx + 1]) {
    saveConfig({ model: args[modelIdx + 1] })
    console.log(c.green(`✓ Model saved: ${args[modelIdx + 1]}`))
    return
  }

  // --status
  if (args.includes('--status')) {
    const cfg = loadConfig()
    console.log(c.bold('\nLoop Code config:'))
    console.log(`  URL:      ${cfg.apiUrl}`)
    console.log(`  Token:    ${cfg.token ? c.green('set') : c.yellow('not set (use --login)')}`)
    console.log(`  Provider: ${cfg.provider || 'hf'}`)
    console.log(`  Model:    ${cfg.model || '(server default)'}`)
    console.log(`  CWD:      ${process.cwd()}\n`)
    return
  }

  // Check auth
  const cfg = loadConfig()
  if (!cfg.token) {
    console.log(c.yellow('\n⚠  No API token set.'))
    console.log(`   Run ${c.bold('loop-code --login')} to authenticate, or set ${c.bold('LOOP_GPT_TOKEN')} in your shell.\n`)
    const proceed = await askYN(c, 'Continue without token (only works if backend allows guest)?')
    if (!proceed) process.exit(0)
  }

  // Single task from args
  const taskFromArgs = args.filter((a) => !a.startsWith('--')).join(' ').trim()
  if (taskFromArgs) {
    await runTask(c, taskFromArgs, [])
    return
  }

  // Interactive REPL
  await repl(c)
}

async function doLogin(c: any) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q: string): Promise<string> => new Promise((r) => rl.question(q, r))

  console.log(c.bold('\nLoop Code — sign in\n'))
  const apiUrl = (await ask(`API URL [https://api.loop-gpt.cyou]: `)).trim() || 'https://api.loop-gpt.cyou'
  const email = await ask('Email: ')
  const password = await ask('Password: ')
  rl.close()

  process.stdout.write(c.dim('Authenticating…'))
  try {
    const res = await fetch(`${apiUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const data = await res.json() as any
    if (!res.ok || !data.token) {
      console.log(c.red(`\n✗ Login failed: ${data.error || res.statusText}`))
      process.exit(1)
    }
    saveConfig({ apiUrl, token: data.token })
    console.log(c.green(`\n✓ Logged in as ${data.user?.email || email}`))
    console.log(c.dim(`  Token saved to ~/.loop-code/config.json\n`))
  } catch (e: any) {
    console.log(c.red(`\n✗ Network error: ${e.message}`))
    process.exit(1)
  }
}

async function repl(c: any) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: c.bold.hex('#c96442')('loop-code') + c.dim(' › '),
  })

  const history: LLMMessage[] = []

  printBanner(c)
  rl.prompt()

  for await (const line of rl) {
    const input = line.trim()
    if (!input) { rl.prompt(); continue }
    if (input === '/exit' || input === '/quit') break
    if (input === '/clear') {
      history.length = 0
      console.log(c.dim('  Context cleared.\n'))
      rl.prompt()
      continue
    }
    if (input === '/status') {
      const cfg = loadConfig()
      console.log(c.dim(`  URL: ${cfg.apiUrl}  |  CWD: ${process.cwd()}\n`))
      rl.prompt()
      continue
    }
    if (input === '/help') {
      console.log(c.dim('  Commands: /clear /status /help /exit\n  Or type any task to run it.\n'))
      rl.prompt()
      continue
    }

    const newHistory = await runTask(c, input, history)
    history.push(...newHistory.slice(history.length))
    rl.prompt()
  }

  console.log(c.dim('\n  Goodbye.\n'))
  rl.close()
}

async function runTask(c: any, task: string, history: LLMMessage[]): Promise<LLMMessage[]> {
  console.log()
  let assistantText = ''

  const newMessages = await runAgentLoop(task, history, {
    onText(text) {
      process.stdout.write(c.white(text))
      assistantText += text
    },
    onToolCall(name, args) {
      const preview = JSON.stringify(args).slice(0, 120)
      console.log(`\n${c.bold.hex('#c96442')('⚙')} ${c.bold(name)} ${c.dim(preview)}`)
    },
    onToolResult(name, result) {
      const lines = result.split('\n').slice(0, 8)
      const preview = lines.join('\n')
      const trimmed = result.split('\n').length > 8 ? preview + c.dim(`\n  … (${result.split('\n').length - 8} more lines)`) : preview
      console.log(c.dim(trimmed.split('\n').map((l: string) => `  ${l}`).join('\n')))
    },
    onDone() {
      if (assistantText) console.log()
    },
    onError(msg) {
      console.log(c.red(`\n⚠ ${msg}`))
    },
  }).catch((e: any) => {
    console.log(c.red(`\n⚠ ${e.message}`))
    return [...history, { role: 'user' as const, content: task }]
  })

  console.log()
  return newMessages
}

function printBanner(c: any) {
  console.log()
  console.log(` ${c.bold.hex('#c96442')('Loop Code')} ${c.dim(`v${VERSION}`)}  —  type a task, or ${c.dim('/help')}`)
  console.log(` ${c.dim('Connected to: ' + (loadConfig().apiUrl))}`)
  console.log()
}

async function askYN(c: any, question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(`  ${question} [y/N] `, (ans) => {
      rl.close()
      resolve(ans.toLowerCase() === 'y')
    })
  })
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
