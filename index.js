import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
  jidNormalizedUser
} from '@whiskeysockets/baileys'

import { Boom } from '@hapi/boom'
import pino from 'pino'

import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { fileURLToPath } from 'url'

import {
  loadPlugins,
  plugins,
  messageListeners,
  groupListeners
} from './lib/plugin-loader.js'

import {
  handleMessages,
  handleGroupParticipants,
  startAlwaysOnline
} from './handler.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const ROOT = __dirname
const SESSION_DIR = path.join(ROOT, 'session')

const PAIR_SERVER_URL =
  process.env.PAIR_SERVER_URL ||
  'https://pair-web-3e08f4e68faf.herokuapp.com'

const SESSION_ID =
  process.env.SESSION_ID || ''

const logger = pino({
  level: 'silent'
})

let sock = null
let reconnecting = false
let activeMessageSent = false

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function ensureDirectories() {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, {
      recursive: true
    })
  }
}

function decodeBase64(value) {
  return Buffer.from(
    value,
    'base64'
  )
}

async function sendActiveMessage() {
  if (
    activeMessageSent ||
    !sock?.user?.id
  ) {
    return
  }

  try {
    const botJid =
      jidNormalizedUser(
        sock.user.id
      )

    if (!botJid) {
      console.error(
        '[WA] Could not determine bot JID.'
      )

      return
    }

    const activeMessage = `
𝐇ᴇʟʟᴏ 𝐓ʜᴇʀᴇ 𝐑ᴀᴢᴀ-𝐌ᴅ 𝐔ꜱᴇʀ! 👋

╭━━━〔 𝐑ᴀᴢᴀ-𝐌ᴅ 〕━━━┈⊷
┃
┃ 𝐌ᴜʟᴛɪ-𝐃ᴇᴠɪᴄᴇ 𝐖ʜᴀᴛsᴀᴘᴘ 𝐁ᴏᴛ
┃ 𝐒ᴛᴀᴛᴜs : 𝐎ɴʟɪɴᴇ ✅
┃ 𝐏ʀᴇғɪx : ${process.env.PREFIX || '.'}
┃ 𝐂ᴏᴍᴍᴀɴᴅs : ${plugins.size}
┃ 𝐌ᴇssᴀɢᴇ 𝐋ɪsᴛᴇɴᴇʀs : ${messageListeners.length}
┃ 𝐆ʀᴏᴜᴘ 𝐋ɪsᴛᴇɴᴇʀs : ${groupListeners.length}
┃
╰━━━━━━━━━━━━━━━━━━━━┈⊷

> 𝐌ᴜʟᴛɪ-𝐃ᴇᴠɪᴄᴇ 𝐖ʜᴀᴛsᴀᴘᴘ 𝐁ᴏᴛ 𝐋ᴏᴀᴅᴇᴅ ✅

𝐓ʜᴀɴᴋs 𝐅ᴏʀ 𝐔sɪɴɢ 𝐑ᴀᴢᴀ-𝐌ᴅ 💗

𝐏ᴏᴡᴇʀᴇᴅ 𝐁ʏ 𝐋ᴇɢᴇɴᴅ 𝐑ᴀᴢᴀ
`.trim()

    await sock.sendMessage(
      botJid,
      {
        text: activeMessage
      }
    )

    activeMessageSent = true

    console.log(
      `[WA] Active message sent to bot: ${botJid}`
    )

  } catch (error) {
    console.error(
      '[WA] Active message error:',
      error?.message ||
        error
    )
  }
}

async function restoreRemoteSession() {
  if (!SESSION_ID) {
    console.log(
      '[SESSION] SESSION_ID not found.'
    )

    return false
  }

  try {
    console.log(
      '[SESSION] Restoring remote session...'
    )

    const url =
      `${PAIR_SERVER_URL.replace(/\/+$/, '')}/api/session/${encodeURIComponent(SESSION_ID)}`

    const response =
      await fetch(url)

    if (!response.ok) {
      console.error(
        `[SESSION] Remote server returned ${response.status}`
      )

      return false
    }

    const data =
      await response.json()

    if (
      !data ||
      !data.files ||
      typeof data.files !== 'object'
    ) {
      console.error(
        '[SESSION] Invalid session response.'
      )

      return false
    }

    ensureDirectories()

    let restored = 0

    for (
      const [fileName, encoded] of
      Object.entries(data.files)
    ) {
      if (
        typeof encoded !==
        'string'
      ) {
        continue
      }

      const safeName =
        path.basename(fileName)

      if (
        !safeName ||
        safeName === '.' ||
        safeName === '..'
      ) {
        continue
      }

      const target =
        path.join(
          SESSION_DIR,
          safeName
        )

      fs.writeFileSync(
        target,
        decodeBase64(encoded)
      )

      restored++
    }

    if (!restored) {
      console.error(
        '[SESSION] No session files restored.'
      )

      return false
    }

    console.log(
      '[SESSION] Remote session restored successfully.'
    )

    return true

  } catch (error) {
    console.error(
      '[SESSION] Restore error:',
      error?.message || error
    )

    return false
  }
}

async function connect() {
  if (reconnecting) {
    return
  }

  reconnecting = true

  try {
    ensureDirectories()

    await restoreRemoteSession()

    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(
      SESSION_DIR
    )

    sock =
      makeWASocket({
        auth: state,

        logger,

        browser:
          Browsers.ubuntu(
            'Chrome'
          ),

        printQRInTerminal:
          false,

        markOnlineOnConnect:
          false,

        syncFullHistory:
          false,

        generateHighQualityLinkPreview:
          false
      })

    sock.ev.on(
      'creds.update',
      saveCreds
    )

    sock.ev.on(
      'connection.update',
      async update => {
        const {
          connection,
          lastDisconnect
        } = update

        if (
          connection ===
          'connecting'
        ) {
          console.log(
            '[WA] Connecting to WhatsApp...'
          )
        }

        if (
          connection ===
          'open'
        ) {
          console.log(
            ''
          )

          console.log(
            '╭──────────────────────────────╮'
          )
          console.log(
            '│     𝐑ᴀᴢᴀ-𝐌ᴅ 𝐂ᴏɴɴᴇᴄᴛᴇᴅ     │'
          )
          console.log(
            '├──────────────────────────────┤'
          )
          console.log(
            '│  𝐌ᴜʟᴛɪ-𝐃ᴇᴠɪᴄᴇ 𝐖ʜᴀᴛsᴀᴘᴘ     │'
          )
          console.log(
            '│  𝐁ᴏᴛ 𝐈s 𝐑ᴜɴɴɪɴɢ             │'
          )
          console.log(
            '╰──────────────────────────────╯'
          )

          console.log(
            `[WA] User: ${sock?.user?.id || 'unknown'}`
          )

          console.log(
            `[WA] Plugins: ${plugins.size}`
          )

          console.log(
            `[WA] Message listeners: ${messageListeners.length}`
          )

          console.log(
            `[WA] Group listeners: ${groupListeners.length}`
          )

          reconnecting = false

          try {
            await startAlwaysOnline(
              sock
            )
          } catch (error) {
            console.error(
              '[WA] Presence error:',
              error?.message ||
                error
            )
          }

          await sendActiveMessage()

          return
        }

        if (
          connection ===
          'close'
        ) {
          const statusCode =
            new Boom(
              lastDisconnect?.error
            )?.output
              ?.statusCode

          console.error(
            `[WA] Connection closed. Code: ${statusCode || 'unknown'}`
          )

          reconnecting = false

          if (
            statusCode ===
            DisconnectReason.loggedOut
          ) {
            console.error(
              '[WA] Session logged out.'
            )

            try {
              fs.rmSync(
                SESSION_DIR,
                {
                  recursive: true,
                  force: true
                }
              )
            } catch {}

            console.error(
              '[WA] Session directory removed. Generate a new session.'
            )

            return
          }

          if (
            statusCode ===
            DisconnectReason.badSession
          ) {
            console.error(
              '[WA] Bad session detected.'
            )

            console.error(
              '[WA] The stored session is invalid or corrupted.'
            )

            return
          }

          console.log(
            '[WA] Reconnecting in 5 seconds...'
          )

          await sleep(5000)

          try {
            await connect()
          } catch (error) {
            console.error(
              '[WA] Reconnect error:',
              error?.message ||
                error
            )
          }
        }
      }
    )

    sock.ev.on(
      'messages.upsert',
      async event => {
        try {
          await handleMessages(
            event,
            sock,
            plugins,
            messageListeners
          )
        } catch (error) {
          console.error(
            '[HANDLER] Message event error:',
            error?.stack ||
              error?.message ||
              error
          )
        }
      }
    )

    sock.ev.on(
      'group-participants.update',
      async event => {
        try {
          await handleGroupParticipants(
            event,
            sock,
            groupListeners
          )
        } catch (error) {
          console.error(
            '[HANDLER] Group event error:',
            error?.stack ||
              error?.message ||
              error
          )
        }
      }
    )

  } catch (error) {
    reconnecting = false

    console.error(
      '[WA] Connection error:',
      error?.stack ||
        error?.message ||
        error
    )

    console.log(
      '[WA] Retrying in 5 seconds...'
    )

    await sleep(5000)

    try {
      await connect()
    } catch (retryError) {
      console.error(
        '[WA] Retry error:',
        retryError?.message ||
          retryError
      )
    }
  }
}

async function start() {
  console.log(
    ''
  )

  console.log(
    '╭──────────────────────────────╮'
  )

  console.log(
    '│       ʀᴀᴢᴀ-ᴍᴅ ᴡʜᴀᴛsᴀᴘᴘ      │'
  )

  console.log(
    '│        ᴍᴜʟᴛɪ-ᴅᴇᴠɪᴄᴇ        │'
  )

  console.log(
    '╰──────────────────────────────╯'
  )

  console.log(
    ''
  )

  console.log(
    '[SYSTEM] Starting Raza-MD...'
  )

  console.log(
    `[SYSTEM] Node: ${process.version}`
  )

  console.log(
    `[SYSTEM] Prefix: ${process.env.PREFIX || '.'}`
  )

  console.log(
    `[SYSTEM] Pair server: ${PAIR_SERVER_URL}`
  )

  try {
    await loadPlugins()

    console.log(
      `[PLUGIN] Loaded ${plugins.size} command(s).`
    )

    console.log(
      `[PLUGIN] Loaded ${messageListeners.length} message listener(s).`
    )

    console.log(
      `[PLUGIN] Loaded ${groupListeners.length} group listener(s).`
    )

  } catch (error) {
    console.error(
      '[PLUGIN] Loader error:',
      error?.stack ||
        error?.message ||
        error
    )
  }

  await connect()
}

process.on(
  'uncaughtException',
  error => {
    console.error(
      '[PROCESS] Uncaught exception:',
      error?.stack ||
        error?.message ||
        error
    )
  }
)

process.on(
  'unhandledRejection',
  error => {
    console.error(
      '[PROCESS] Unhandled rejection:',
      error?.stack ||
        error?.message ||
        error
    )
  }
)

process.on(
  'SIGTERM',
  () => {
    console.log(
      '[PROCESS] SIGTERM received.'
    )

    try {
      sock?.end(
        new Error(
          'Process terminated'
        )
      )
    } catch {}

    process.exit(0)
  }
)

process.on(
  'SIGINT',
  () => {
    console.log(
      '[PROCESS] SIGINT received.'
    )

    try {
      sock?.end(
        new Error(
          'Process interrupted'
        )
      )
    } catch {}

    process.exit(0)
  }
)

start()
