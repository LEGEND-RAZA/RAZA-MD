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

let sock
let reconnecting = false

const plugins = new Map()
const messageListeners = []
const groupListeners = []

function question(text) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  return new Promise((resolve) => {
    rl.question(text, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

/**
 * Detect special listener plugins.
 * Examples:
 * __antilink_listener
 * __antigroupstatus_listener
 * __antimention_listener
 */
function isSpecialListener(pluginObj) {
  if (typeof pluginObj?.command !== 'string') return false

  return (
    pluginObj.command.startsWith('__') &&
    pluginObj.command.endsWith('_listener')
  )
}

/**
 * Universal Plugin Registrar
 */
async function registerPluginObject(pluginObj, file) {
  if (!pluginObj || typeof pluginObj !== 'object') return

  const specialListener = isSpecialListener(pluginObj)

  /*
   * 1. Group Listeners
   */
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
      console.log(`[+] Group listener registered from ${file}`)
    }
  }

  /*
   * 2. Message Listeners
   *
   * Any __something_listener except __welcome_listener
   * is treated as a passive message listener.
   */
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
      console.log(`[+] Message listener registered from ${file}`)
    }
  }

  /*
   * 3. Normal Commands
   *
   * Special listener commands are never registered
   * as normal commands.
   */
  if (pluginObj.command && !specialListener) {
    const commandNames = Array.isArray(pluginObj.command)
      ? pluginObj.command
      : [pluginObj.command]

    for (const command of commandNames) {
      plugins.set(String(command).toLowerCase(), pluginObj)
    }

    console.log(
      `[+] Command(s) [${commandNames.join(', ')}] registered from ${file}`
    )
  }
}

/**
 * Dynamic Plugin Auto-Loader
 */
async function loadPlugins() {
  plugins.clear()
  messageListeners.length = 0
  groupListeners.length = 0

  if (!fs.existsSync(PLUGIN_DIR)) {
    fs.mkdirSync(PLUGIN_DIR, { recursive: true })
  }

  const entries = fs
    .readdirSync(PLUGIN_DIR)
    .filter((file) => file.endsWith('.js'))

  for (const file of entries) {
    try {
      const filePath = path.join(PLUGIN_DIR, file)

      const url =
        `${pathToFileURL(filePath).href}?v=${Date.now()}`

      const mod = await import(url)

      const exports = [
        mod.default,
        ...Object.values(mod)
      ]

      const processed = new Set()

      for (const item of exports) {
        if (!item || processed.has(item)) continue

        processed.add(item)

        await registerPluginObject(item, file)
      }
    } catch (e) {
      console.error(
        `[-] Failed to load plugin ${file}:`,
        e?.message || e
      )
    }
  }

  console.log(
    `\n[SUMMARY] Loaded: ${plugins.size} commands, ` +
    `${messageListeners.length} message listeners, ` +
    `and ${groupListeners.length} group listeners.\n`
  )
}

/**
 * Start WhatsApp Bot
 */
async function startBot() {
  if (reconnecting) return

  reconnecting = true

  try {
    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(SESSION_DIR)

    sock = makeWASocket({
      auth: state,

      browser: Browsers.ubuntu('Chrome'),

      logger,

      markOnlineOnConnect: false,

      syncFullHistory: false,

      generateHighQualityLinkPreview: false,

      badSessionDeleteHistory: true
    })

    /*
     * Save authentication credentials
     */
    sock.ev.on('creds.update', saveCreds)

    /*
     * Message Handler
     */
    sock.ev.on(
      'messages.upsert',
      (update) =>
        handleMessages(
          update,
          sock,
          plugins,
          messageListeners
        )
    )

    /*
     * Group Participant Handler
     */
    sock.ev.on(
      'group-participants.update',
      (update) =>
        handleGroupParticipants(
          update,
          sock,
          groupListeners
        )
    )

    /*
     * Connection Handler
     */
    sock.ev.on(
      'connection.update',
      async ({
        connection,
        lastDisconnect
      }) => {

        if (connection === 'connecting') {
          console.log(
            '[...] Connecting to WhatsApp...'
          )
        }

        if (connection === 'open') {
          reconnecting = false

          console.log(
            '[OK] Raza connected successfully!'
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
            `Message Listeners: ${messageListeners.length}`
          )
        }

        if (connection === 'close') {
          reconnecting = false

          const code =
            new Boom(lastDisconnect?.error)
              ?.output
              ?.statusCode

          const loggedOut =
            code === DisconnectReason.loggedOut

          console.log(
            `[-] Connection closed. Code: ${
              code ?? 'unknown'
            }`
          )

          /*
           * Logged out
           */
          if (loggedOut) {
            console.log(
              '[!] Session was logged out.'
            )

            console.log(
              '[!] Delete the "session" folder and re-pair.'
            )

            return
          }

          /*
           * Reconnect automatically
           */
          console.log(
            '[...] Reconnecting in 3 seconds...'
          )

          setTimeout(
            startBot,
            3000
          )
        }
      }
    )

    /*
     * Pairing Code Login
     */
    if (!sock.authState.creds.registered) {

      let number =
        (process.env.PAIRING_NUMBER || '')
          .replace(/\D/g, '')

      if (!number) {
        number = (
          await question(
            'Enter WhatsApp number with country code (digits only): '
          )
        ).replace(/\D/g, '')
      }

      if (!number || number.length < 7) {
        reconnecting = false

        console.error(
          '[-] Invalid phone number provided.'
        )

        return
      }

      /*
       * Give connection a moment before
       * requesting the pairing code.
       */
      await new Promise(
        (resolve) =>
          setTimeout(resolve, 3000)
      )

      try {
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
          '       RAZA PAIRING CODE'
        )

        console.log(
          `          ${formattedCode}`
        )

        console.log(
          '==================================\n'
        )

      } catch (e) {
        reconnecting = false

        console.error(
          '[-] Pairing code request failed:',
          e?.message || e
        )

        return
      }
    }

  } catch (e) {

    reconnecting = false

    console.error(
      'Startup error:',
      e
    )

    setTimeout(
      startBot,
      5000
    )
  }
}

/*
 * Load all plugins first,
 * then start WhatsApp.
 */
await loadPlugins()
await startBot()