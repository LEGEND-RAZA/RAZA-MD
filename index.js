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

const PREFIX = process.env.PREFIX || '!'

const logger = P({ level: 'silent' })

let sock = null
let starting = false
let reconnectTimer = null
let pairingRequested = false
let stopping = false

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
  if (typeof pluginObj?.command !== 'string') {
    return false
  }

  return (
    pluginObj.command.startsWith('__') &&
    pluginObj.command.endsWith('_listener')
  )
}

async function registerPluginObject(pluginObj, file) {
  if (!pluginObj || typeof pluginObj !== 'object') {
    return
  }

  const specialListener = isSpecialListener(pluginObj)

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

  if (isMessageListener && !isGroupListener) {
    if (!messageListeners.includes(pluginObj)) {
      messageListeners.push(pluginObj)

      console.log(
        `[+] Message listener registered from ${file}`
      )
    }
  }

  if (pluginObj.command && !specialListener) {
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
      .filter(file => file.endsWith('.js'))

  for (const file of entries) {
    try {
      const filePath =
        path.join(PLUGIN_DIR, file)

      const url =
        `${pathToFileURL(filePath).href}?v=${Date.now()}`

      const mod = await import(url)

      const exports = [
        mod.default,
        ...Object.values(mod)
      ]

      const processed = new Set()

      for (const item of exports) {
        if (!item || processed.has(item)) {
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
      '[!] Set PAIRING_NUMBER in Heroku Config Vars.'
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
  if (pairingRequested) {
    return
  }

  pairingRequested = true

  const number =
    await getPairingNumber()

  if (!number || number.length < 7) {
    console.error(
      '[-] Invalid pairing number.'
    )

    pairingRequested = false
    return
  }

  try {
    await new Promise(resolve =>
      setTimeout(resolve, 3000)
    )

    if (!sock) {
      pairingRequested = false
      return
    }

    const pairingCode =
      await sock.requestPairingCode(number)

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

  } catch (error) {
    pairingRequested = false

    console.error(
      '[-] Pairing code request failed:',
      error?.message || error
    )
  }
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function scheduleReconnect() {
  if (stopping || reconnectTimer) {
    return
  }

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null

    try {
      await startBot()
    } catch (error) {
      console.error(
        '[Reconnect Error]:',
        error?.message || error
      )
    }
  }, 5000)
}

async function startBot() {
  if (stopping || starting) {
    return
  }

  starting = true

  try {
    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(
      SESSION_DIR
    )

    if (stopping) {
      starting = false
      return
    }

    sock = makeWASocket({
      auth: state,

      browser:
        Browsers.ubuntu('Chrome'),

      logger,

      markOnlineOnConnect: false,

      syncFullHistory: false,

      generateHighQualityLinkPreview: false,

      connectTimeoutMs: 60000,

      defaultQueryTimeoutMs: 60000,

      keepAliveIntervalMs: 25000,

      retryRequestDelayMs: 250,

      fireInitQueries: true,

      emitOwnEvents: false,

      shouldIgnoreJid: jid =>
        jid === 'status@broadcast'
    })

    const currentSock = sock

    currentSock.ev.on(
      'creds.update',
      saveCreds
    )

    currentSock.ev.on(
      'messages.upsert',
      update => {
        if (currentSock !== sock) {
          return
        }

        Promise.resolve(
          handleMessages(
            update,
            currentSock,
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

    currentSock.ev.on(
      'group-participants.update',
      update => {
        if (currentSock !== sock) {
          return
        }

        Promise.resolve(
          handleGroupParticipants(
            update,
            currentSock,
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

    currentSock.ev.on(
      'connection.update',
      async ({
        connection,
        lastDisconnect
      }) => {

        if (currentSock !== sock) {
          return
        }

        if (connection === 'connecting') {
          console.log(
            '[...] Connecting to WhatsApp...'
          )
        }

        if (connection === 'open') {
          starting = false
          pairingRequested = false

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
        }

        if (connection === 'close') {
          starting = false

          const code =
            new Boom(
              lastDisconnect?.error
            )?.output?.statusCode

          const loggedOut =
            code === DisconnectReason.loggedOut

          console.log(
            `[-] Connection closed. Code: ${
              code ?? 'unknown'
            }`
          )

          if (sock === currentSock) {
            sock = null
          }

          if (loggedOut) {
            console.log(
              '[!] Session was logged out.'
            )

            console.log(
              '[!] Delete the "session" folder and re-pair.'
            )

            return
          }

          console.log(
            '[...] Reconnecting in 5 seconds...'
          )

          scheduleReconnect()
        }
      }
    )

    if (!state.creds.registered) {
      await requestPairingCode()
    }

  } catch (error) {
    starting = false

    console.error(
      '[Startup Error]:',
      error?.message || error
    )

    if (!stopping) {
      scheduleReconnect()
    }
  }
}

process.on('SIGTERM', () => {
  stopping = true
  clearReconnectTimer()

  try {
    sock?.end?.(
      new Error('Process terminated')
    )
  } catch {}

  process.exit(0)
})

process.on('SIGINT', () => {
  stopping = true
  clearReconnectTimer()

  try {
    sock?.end?.(
      new Error('Process interrupted')
    )
  } catch {}

  process.exit(0)
})

await loadPlugins()
await startBot()
