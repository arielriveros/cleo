#!/usr/bin/env node
// The `cleo` command of a project folder (copied into .cleo/sdk/cleo/bin by the editor whenever the project
// opens; package.json's scripts run it). It drives the Cleo editor that last opened this project:
//
//   cleo play            Play in window (opens the project in Cleo first if it is not the open one,
//                        and starts Cleo if it is not running)
//   cleo play --debug    the same, with VS Code's debugger on for this session ("Debug Cleo game", F5)
//   cleo open            open the project in Cleo
//   cleo status          which project the running Cleo has open
//
// It talks to the editor over its control pipe (named in .cleo/local/editor.json, with the token that lets
// it in). Zero dependencies: it must run before `npm install`.

import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const command = args[0] ?? 'help'
const debug = args.includes('--debug')
const sleep = ms => new Promise(r => setTimeout(r, ms))

function fail(message, code = 1) {
  console.error(`cleo: ${message}`)
  process.exit(code)
}

/** The project folder: --project <dir>, else the nearest folder up from here holding project.cleo. */
function projectRoot() {
  const at = args.indexOf('--project')
  if (at >= 0 && args[at + 1]) return path.resolve(args[at + 1])
  let dir = process.cwd()
  for (;;) {
    if (fs.existsSync(path.join(dir, 'project.cleo'))) return dir
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

function editorRecord(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, '.cleo', 'local', 'editor.json'), 'utf-8')) } catch { return null }
}

/** A connected socket to the pipe, or null. */
function connect(pipe, timeoutMs = 1500) {
  return new Promise(resolve => {
    const socket = net.connect(pipe)
    const timer = setTimeout(() => { socket.destroy(); resolve(null) }, timeoutMs)
    socket.once('connect', () => { clearTimeout(timer); resolve(socket) })
    socket.once('error', () => { clearTimeout(timer); resolve(null) })
  })
}

/** One request, its reply. Playing can wait for the project to open, so the wait is long. */
function request(socket, message, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Cleo did not answer')) }, timeoutMs)
    socket.setEncoding('utf-8')
    socket.on('data', chunk => {
      buffer += chunk
      const at = buffer.indexOf('\n')
      if (at < 0) return
      clearTimeout(timer)
      socket.end()
      try { resolve(JSON.parse(buffer.slice(0, at))) } catch (e) { reject(e) }
    })
    socket.on('error', e => { clearTimeout(timer); reject(e) })
    socket.write(JSON.stringify({ id: 1, ...message }) + '\n')
  })
}

/** Start the editor this project was last opened with, on this project. */
function launch(record, root) {
  const exe = process.env.CLEO_EDITOR || record?.relaunch?.exe
  if (!exe || !fs.existsSync(exe)) {
    fail('Cleo is not running, and this project has not been opened in Cleo on this machine yet. Open it in Cleo once (Project ▸ Open Folder…), or set CLEO_EDITOR to the Cleo executable.')
  }
  const env = { ...process.env, ...(record?.relaunch?.env ?? {}) }
  // Set by anything a VS Code extension spawns; it would make Electron run as plain Node.
  delete env.ELECTRON_RUN_AS_NODE
  const extra = process.env.CLEO_EDITOR ? [] : (record?.relaunch?.args ?? [])
  const child = spawn(exe, [...extra, '--cleo-open', root], { detached: true, stdio: 'ignore', env })
  child.unref()
}

async function main() {
  if (command === 'help' || command === '--help') {
    console.log('usage: cleo play [--debug] | cleo open | cleo status   (in a Cleo project folder)')
    return
  }
  if (!['play', 'open', 'status'].includes(command)) fail(`unknown command "${command}" (try: cleo help)`)
  const root = projectRoot()
  if (!root) fail('not in a Cleo project folder (no project.cleo here or above)')
  let record = editorRecord(root)

  let socket = record?.pipe ? await connect(record.pipe) : null
  if (!socket) {
    if (command === 'status') { console.log('Cleo is not running.'); return }
    console.log('Starting Cleo…')
    launch(record, root)
    const deadline = Date.now() + 120_000
    while (!socket && Date.now() < deadline) {
      await sleep(1000)
      record = editorRecord(root) ?? record
      if (record?.pipe) socket = await connect(record.pipe)
    }
    if (!socket) fail('Cleo did not start in time')
  }

  const reply = await request(socket, { token: record.token, cmd: command === 'status' ? 'ping' : command, root, debug })
  if (!reply.ok) fail(reply.error || 'Cleo refused the request')
  if (command === 'status') console.log(reply.root ? `Cleo has ${reply.root} open.` : 'Cleo has no project open.')
  else if (command === 'open') console.log(`Opened ${root} in Cleo.`)
  else console.log(debug
    ? `Playing in a window, with VS Code's debugger on port ${reply.port ?? 'the debug port'}.`
    : 'Playing in a window.')
}

main().catch(e => fail(e?.message ?? String(e)))
