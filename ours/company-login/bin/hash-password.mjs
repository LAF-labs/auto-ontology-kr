#!/usr/bin/env node
/**
 * Print the scrypt hash of a password for COMPANY_LOGIN_PASSWORD_HASH.
 *
 *   node bin/hash-password.mjs              asks twice on the terminal without echo
 *   node bin/hash-password.mjs < file       reads the first line of standard input
 *
 * The password is never taken from an argument (arguments show up in `ps` and
 * shell history) and never printed.
 */
import { createInterface } from 'node:readline'
import { hashPassword } from '../src/password.js'

function ask(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true })
    rl._writeToOutput = (text) => { if (text.includes(prompt)) process.stderr.write(prompt) }
    rl.question(prompt, (answer) => { rl.close(); process.stderr.write('\n'); resolve(answer) })
  })
}

async function readStdinLine() {
  let data = ''
  for await (const chunk of process.stdin) data += chunk
  return data.split(/\r?\n/)[0]
}

if (process.argv.length > 2) {
  console.error('usage: hash-password.mjs   (the password is read from the terminal or standard input, never from an argument)')
  process.exit(2)
}
let password
if (process.stdin.isTTY) {
  password = await ask('Password: ')
  if (await ask('Again: ') !== password) { console.error('the two entries differ'); process.exit(1) }
} else {
  password = await readStdinLine()
}
try {
  console.log(await hashPassword(password))
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
