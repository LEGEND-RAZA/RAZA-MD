import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState
} from '@whiskeysockets/baileys'

import P from 'pino'
import { Boom } from '@hapi/boom'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'

import {
  handleMessages,
  handleGroupParticipants
} from './handler.js'

const ROOT = process.cwd()

const SESSION_DIR = path.join(ROOT, 'session')
const PLUGIN_DIR = path.join(ROOT, 'plugins')

const PREFIX =
  process.env.PREFIX || '!'

const logger =
  P({ level: 'silent' })

let sock = null
let starting = false
let reconnectTimer = null
let shuttingDown = false

// Pairing is allowed only once during this process.
// Never request another code after a reconnect.
let pairingRequested = false

const plugins = new Map()
const messageListeners = []
const groupListeners = []

function question(text) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  return new Promise(resolve => {
    rl.question(text, answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

function isSpecialListener(pluginObj) {
  if (
    typeof pluginObj?.command !== 'string'
  ) {
    return false
  }

  return (
    pluginObj.command.startsWith('__') &&
    pluginObj.command.endsWith('_listener')
  )
}

async function registerPluginObject(
  pluginObj,
  file
) {
  if (
    !pluginObj ||
    typeof pluginObj !== 'object'
  ) {
    return
  }

  const specialListener =
    isSpecialListener(pluginObj)

  const isGroupListener =
    pluginObj.command === '__welcome_listener' ||
    pluginObj.type === 'welcome' ||
    (
      typeof pluginObj.run === 'function' &&
      !pluginObj.command &&
      pluginObj.isGroupEvent
    )

  if (isGroupListener) {
    if (!groupListeners.includes(pluginObj)) {
      groupListeners.push(pluginObj)

      console.log(
        `[+] Group listener registered from ${file}`
      )
    }
  }

  const isMessageListener =
    (
      specialListener &&
      pluginObj.command !== '__welcome_listener'
    ) ||
    pluginObj.on === 'text' ||
    typeof pluginObj.on === 'function'

  if (
    isMessageListener &&
    !isGroupListener
  ) {
    if (!messageListeners.includes(pluginObj)) {
      messageListeners.push(pluginObj)

      console.log(
        `[+] Message listener registered from ${file}`
      )
    }
  }

  if (
    pluginObj.command &&
    !specialListener
  ) {
    const commandNames =
      Array.isArray(pluginObj.command)
        ? pluginObj.command
        : [pluginObj.command]

    for (const command of commandNames) {
      plugins.set(
        String(command).toLowerCase(),
        pluginObj
      )
    }

    console.log(
      `[+] Command(s) [${commandNames.join(', ')}] registered from ${file}`
    )
  }
}

async function loadPlugins() {
  plugins.clear()
  messageListeners.length = 0
  groupListeners.length = 0

  if (!fs.existsSync(PLUGIN_DIR)) {
    fs.mkdirSync(
      PLUGIN_DIR,
      { recursive: true }
    )
  }

  const entries =
    fs.readdirSync(PLUGIN_DIR)
      .filter(file =>
        file.endsWith('.js')
      )

  for (const file of entries) {
    try {
      const filePath =
        path.join(
          PLUGIN_DIR,
          file
        )

      const url =
        `${pathToFileURL(filePath).href}?v=${Date.now()}`

      const mod =
        await import(url)

      const exports = [
        mod.default,
        ...Object.values(mod)
      ]

      const processed = new Set()

      for (const item of exports) {
        if (
          !item ||
          processed.has(item)
        ) {
          continue
        }

        processed.add(item)

        await registerPluginObject(
          item,
          file
        )
      }

    } catch (error) {
      console.error(
        `[-] Failed to load plugin ${file}:`,
        error?.message || error
      )
    }
  }

  console.log(
    `\n[SUMMARY] Loaded: ${plugins.size} commands, ` +
    `${messageListeners.length} message listeners, ` +
    `${groupListeners.length} group listeners.\n`
  )
}

async function getPairingNumber() {
  let number =
    (process.env.PAIRING_NUMBER || '')
      .replace(/\D/g, '')

  if (number) {
    console.log(
      `[+] Pairing number loaded from environment: ${number}`
    )

    return number
  }

  if (
    process.env.NODE_ENV === 'production' ||
    process.env.DYNO
  ) {
    console.error(
      '\n[!] PAIRING_NUMBER is required on Heroku.'
    )

    console.error(
      '[!] Add PAIRING_NUMBER in Config Vars.'
    )

    console.error(
      '[!] Example: PAIRING_NUMBER=923XXXXXXXXX\n'
    )

    return ''
  }

  number =
    await question(
      'Enter WhatsApp number with country code (digits only): '
    )

  return number.replace(/\D/g, '')
}

async function requestPairingCode() {

  // Never request a second code during this process.
  if (pairingRequested) {
    return
  }

  // Socket must exist.
  if (!sock) {
    return
  }

  // Check the CURRENT auth state again.
  if (sock.authState?.creds?.registered) {
    console.log(
      '[OK] Existing WhatsApp session found. Pairing code not required.'
    )

    return
  }

  pairingRequested = true

  const number =
    await getPairingNumber()

  if (
    !number ||
    number.length < 7
  ) {
    console.error(
      '[-] Invalid pairing number.'
    )

    return
  }

  console.log(
    '\n=================================='
  )

  console.log(
    '       RAZA-MD PAIRING CODE'
  )

  console.log(
    `       Pairing Number: ${number}`
  )

  console.log(
    '=================================='
  )

  try {

    await new Promise(resolve =>
      setTimeout(resolve, 3000)
    )

    // Check again after the delay.
    if (
      sock.authState?.creds?.registered
    ) {
      console.log(
        '[OK] Session became registered. Skipping pairing code.'
      )

      return
    }

    const pairingCode =
      await sock.requestPairingCode(
        number
      )

    const formattedCode =
      pairingCode
        ?.match(/.{1,4}/g)
        ?.join('-') ||
      pairingCode

    console.log(
      '\n=================================='
    )

    console.log(
      '       RAZA-MD PAIRING CODE'
    )

    console.log(
      `          ${formattedCode}`
    )

    console.log(
      '==================================\n'
    )

    console.log(
      '[!] Use this code to link Raza-MD.'
    )

    console.log(
      '[!] No new pairing code will be requested during this process.'
    )

  } catch (error) {

    console.error(
      '[-] Pairing code request failed:',
      error?.message || error
    )

    // Keep pairingRequested true.
    // This prevents automatic code spam.
  }
}

function scheduleReconnect() {

  if (
    shuttingDown ||
    reconnectTimer
  ) {
    return
  }

  console.log(
    '[...] Reconnecting in 5 seconds...'
  )

  reconnectTimer =
    setTimeout(() => {

      reconnectTimer = null

      startBot()

    }, 5000)
}

async function startBot() {

  if (
    shuttingDown ||
    starting
  ) {
    return
  }

  starting = true

  try {

    const {
      state,
      saveCreds
    } =
      await useMultiFileAuthState(
        SESSION_DIR
      )

    /*
     * IMPORTANT:
     * Check the session BEFORE creating/requesting pairing.
     */
    const sessionExists =
      Boolean(
        state?.creds?.registered
      )

    if (sessionExists) {

      console.log(
        '[OK] Existing WhatsApp session detected.'
      )

      console.log(
        '[OK] Pairing code will NOT be requested.'
      )

    } else {

      console.log(
        '[!] No registered WhatsApp session found.'
      )

      console.log(
        '[!] Pairing will be requested only once.'
      )
    }

    /*
     * Close the previous socket if one exists.
     */
    if (sock) {
      try {
        sock.ev.removeAllListeners()
        sock.ws?.close()
      } catch {}
    }

    sock = makeWASocket({

      auth: state,

      browser:
        Browsers.ubuntu('Chrome'),

      logger,

      markOnlineOnConnect: false,

      syncFullHistory: false,

      generateHighQualityLinkPreview: false,

      badSessionDeleteHistory: true,

      connectTimeoutMs: 60000,

      defaultQueryTimeoutMs: 60000,

      keepAliveIntervalMs: 25000,

      retryRequestDelayMs: 250,

      fireInitQueries: true,

      emitOwnEvents: false

    })

    sock.ev.on(
      'creds.update',
      saveCreds
    )

    sock.ev.on(
      'messages.upsert',
      update => {

        Promise.resolve(
          handleMessages(
            update,
            sock,
            plugins,
            messageListeners
          )
        ).catch(error => {

          console.error(
            '[Message Handler Error]:',
            error?.message || error
          )

        })

      }
    )

    sock.ev.on(
      'group-participants.update',
      update => {

        Promise.resolve(
          handleGroupParticipants(
            update,
            sock,
            groupListeners
          )
        ).catch(error => {

          console.error(
            '[Group Handler Error]:',
            error?.message || error
          )

        })

      }
    )

    sock.ev.on(
      'connection.update',
      async ({
        connection,
        lastDisconnect
      }) => {

        if (
          connection === 'connecting'
        ) {

          console.log(
            '[...] Connecting to WhatsApp...'
          )

        }

        if (
          connection === 'open'
        ) {

          starting = false

          console.log(
            '\n[OK] Raza-MD connected successfully!'
          )

          console.log(
            `Prefix active: "${PREFIX}"`
          )

          console.log(
            `Active Commands: ${plugins.size}`
          )

          console.log(
            `Group Listeners: ${groupListeners.length}`
          )

          console.log(
            `Message Listeners: ${messageListeners.length}\n`
          )

          /*
           * IMPORTANT:
           * Do NOT reset pairingRequested here.
           *
           * If the connection later closes,
           * another pairing code will NOT be requested.
           */

        }

        if (
          connection === 'close'
        ) {

          starting = false

          const code =
            new Boom(
              lastDisconnect?.error
            )?.output?.statusCode

          const loggedOut =
            code ===
            DisconnectReason.loggedOut

          const badSession =
            code ===
            DisconnectReason.badSession

          console.log(
            `[-] Connection closed. Code: ${
              code ?? 'unknown'
            }`
          )

          if (loggedOut) {

            console.log(
              '[!] WhatsApp session was logged out.'
            )

            console.log(
              '[!] Delete the session folder and pair again.'
            )

            return
          }

          if (badSession) {

            console.log(
              '[!] WhatsApp session is invalid.'
            )

            console.log(
              '[!] Delete the session folder and pair again.'
            )

            return
          }

          /*
           * 515 is allowed.
           *
           * It can happen during the pairing/login flow.
           * Reconnect using the existing auth state.
           *
           * DO NOT request another pairing code.
           */
          if (code === 515) {

            console.log(
              '[i] Connection closed with 515.'
            )

            console.log(
              '[i] Reconnecting with existing session state...'
            )

          }

          scheduleReconnect()
        }
      }
    )

    starting = false

    /*
     * ONLY request pairing when there is NO registered session.
     *
     * This happens once.
     */
    if (
      !sessionExists &&
      !pairingRequested
    ) {

      await requestPairingCode()

    }

  } catch (error) {

    starting = false

    console.error(
      '[Startup Error]:',
      error?.message || error
    )

    scheduleReconnect()
  }
}

async function shutdown(signal) {

  if (shuttingDown) {
    return
  }

  shuttingDown = true

  console.log(
    `\n[!] ${signal} received. Shutting down...`
  )

  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  try {

    if (sock) {

      sock.ev.removeAllListeners()

      try {
        sock.ws?.close()
      } catch {}

      sock = null
    }

  } catch {}

  process.exit(0)
}

process.once(
  'SIGTERM',
  () => shutdown('SIGTERM')
)

process.once(
  'SIGINT',
  () => shutdown('SIGINT')
)

await loadPlugins()

await startBot()
