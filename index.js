import {
  makeWASocket,
  Browsers,
  DisconnectReason,
  useMultiFileAuthState
} from '@whiskeysockets/baileys'

import {
  Boom
} from '@hapi/boom'

import pino from 'pino'

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

import {
  loadPlugins,
  plugins,
  messageListeners,
  groupListeners
} from './lib/plugin-loader.js'

import {
  handleMessages,
  handleGroupParticipants
} from './handler.js'

const ROOT = process.cwd()

const SESSION_DIR =
  path.join(ROOT, 'session')

const PREFIX =
  process.env.PREFIX || '.'

const PAIR_SERVER_URL =
  process.env.PAIR_SERVER_URL || ''

const SESSION_ID =
  process.env.SESSION_ID || ''

const OWNER_NUMBER =
  process.env.OWNER_NUMBER || ''

const ALWAYS_ONLINE =
  String(
    process.env.ALWAYS_ONLINE || 'false'
  ).toLowerCase() === 'true'

const MODE =
  process.env.MODE || 'private'

let reconnecting = false

const logger =
  pino({
    level: 'silent'
  })

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  )
}

function ensureSessionDirectory() {
  if (
    !fs.existsSync(
      SESSION_DIR
    )
  ) {
    fs.mkdirSync(
      SESSION_DIR,
      {
        recursive: true
      }
    )
  }
}

function clearSessionDirectory() {
  ensureSessionDirectory()

  for (
    const file of
    fs.readdirSync(
      SESSION_DIR
    )
  ) {
    const filePath =
      path.join(
        SESSION_DIR,
        file
      )

    try {
      fs.rmSync(
        filePath,
        {
          recursive: true,
          force: true
        }
      )
    } catch {}
  }
}

function hasLocalSession() {
  if (
    !fs.existsSync(
      SESSION_DIR
    )
  ) {
    return false
  }

  const files =
    fs.readdirSync(
      SESSION_DIR
    )

  return files.length > 0
}

async function restoreRemoteSession(
  token
) {
  if (
    !PAIR_SERVER_URL ||
    !token
  ) {
    return false
  }

  try {
    console.log(
      '[SESSION] Fetching session from pairing server...'
    )

    const baseUrl =
      PAIR_SERVER_URL.replace(
        /\/$/,
        ''
      )

    const url =
      `${baseUrl}/api/session/${encodeURIComponent(token)}`

    const response =
      await fetch(url)

    if (
      !response.ok
    ) {
      console.error(
        `[SESSION] Pairing server returned HTTP ${response.status}`
      )

      return false
    }

    const data =
      await response.json()

    if (
      !data?.success ||
      !data?.files ||
      typeof data.files !== 'object'
    ) {
      console.error(
        '[SESSION] Invalid session response.'
      )

      return false
    }

    clearSessionDirectory()

    for (
      const [
        fileName,
        content
      ]
      of Object.entries(
        data.files
      )
    ) {
      if (
        typeof content !== 'string'
      ) {
        continue
      }

      const filePath =
        path.join(
          SESSION_DIR,
          fileName
        )

      fs.mkdirSync(
        path.dirname(filePath),
        {
          recursive: true
        }
      )

      fs.writeFileSync(
        filePath,
        Buffer.from(
          content,
          'base64'
        )
      )
    }

    console.log(
      '[SESSION] Remote session restored successfully.'
    )

    return true
  } catch (error) {
    console.error(
      '[SESSION] Failed to restore remote session:',
      error?.message || error
    )

    return false
  }
}

async function askPairingNumber() {
  const rl =
    readline.createInterface({
      input: process.stdin,
      output: process.stdout
    })

  const number =
    await new Promise(
      resolve => {
        rl.question(
          'Enter WhatsApp number with country code: ',
          answer => {
            rl.close()

            resolve(
              String(
                answer || ''
              ).replace(
                /\D/g,
                ''
              )
            )
          }
        )
      }
    )

  return number
}

async function loadRemoteSessionIfNeeded() {
  if (
    hasLocalSession()
  ) {
    console.log(
      '[SESSION] Local session found.'
    )

    return true
  }

  if (
    SESSION_ID &&
    PAIR_SERVER_URL
  ) {
    return await restoreRemoteSession(
      SESSION_ID
    )
  }

  return false
}

async function createSocket() {
  ensureSessionDirectory()

  await loadRemoteSessionIfNeeded()

  const {
    state,
    saveCreds
  } =
    await useMultiFileAuthState(
      SESSION_DIR
    )

  const sock =
    makeWASocket({
      auth: state,

      browser:
        Browsers.macOS(
          'Chrome'
        ),

      logger,

      printQRInTerminal:
        false,

      markOnlineOnConnect:
        ALWAYS_ONLINE,

      syncFullHistory:
        false,

      generateHighQualityLinkPreview:
        false,

      connectTimeoutMs:
        60000,

      defaultQueryTimeoutMs:
        60000,

      keepAliveIntervalMs:
        25000,

      retryRequestDelayMs:
        250
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
        connection === 'open'
      ) {
        reconnecting = false

        console.log('')
        console.log(
          '╭──────────────────────────╮'
        )
        console.log(
          '│     ʀᴀᴢᴀ-ᴍᴅ ᴄᴏɴɴᴇᴄᴛᴇᴅ     │'
        )
        console.log(
          '╰──────────────────────────╯'
        )
        console.log(
          `✓ Prefix : ${PREFIX}`
        )
        console.log(
          `✓ Mode   : ${MODE}`
        )

        try {
          await loadPlugins()

          console.log(
            `✓ Plugins: ${plugins.size}`
          )
        } catch (error) {
          console.error(
            '[PLUGIN] Failed to load plugins:',
            error?.message || error
          )
        }

        console.log('')

        try {
          if (
            sock.user?.id
          ) {
            await sock.sendMessage(
              sock.user.id,
              {
                text:
                  `𝐇ᴇʟʟᴏ 𝐓ʜᴇʀᴇ 𝐑ᴀᴢᴀ-𝐌ᴅ 𝐔ꜱᴇʀ!\n\n` +
                  `> 𝐌ᴜʟᴛɪ-𝐃ᴇᴠɪᴄᴇ 𝐖ʜᴀᴛꜱᴀᴘᴘ 𝐁ᴏᴛ 𝐋ᴏᴀᴅᴇᴅ\n\n` +
                  `╭─❒ ʀᴀᴢᴀ-ᴍᴅ\n` +
                  `│ ⟡ ᴏᴡɴᴇʀ : ʟᴇɢᴇɴᴅ ʀᴀᴢᴀ\n` +
                  `│ ⟡ ᴍᴏᴅᴇ : ${MODE}\n` +
                  `│ ⟡ ᴘʀᴇғɪx : ${PREFIX}\n` +
                  `│ ⟡ ᴘʟᴜɢɪɴs : ${plugins.size}\n` +
                  `╰──────────────\n\n` +
                  `𝐓ʜᴀɴᴋꜱ 𝐅ᴏʀ 𝐔ꜱɪɴɢ 𝐑ᴀᴢᴀ-𝐌ᴅ\n` +
                  `𝐏ᴏᴡᴇʀᴇᴅ 𝐁ʏ 𝐋ᴇɢᴇɴᴅ 𝐑ᴀᴢᴀ`
              }
            )
          }
        } catch (error) {
          console.error(
            '[STARTUP] Failed to send startup message:',
            error?.message || error
          )
        }
      }

      if (
        connection === 'close'
      ) {
        const statusCode =
          new Boom(
            lastDisconnect?.error
          )?.output?.statusCode

        console.log(
          `[CONNECTION] Closed with status ${statusCode}`
        )

        if (
          statusCode ===
          DisconnectReason.loggedOut
        ) {
          console.error(
            '[CONNECTION] Session logged out.'
          )

          process.exit(1)
        }

        if (
          statusCode ===
          DisconnectReason.connectionReplaced
        ) {
          console.error(
            '[CONNECTION] Connection replaced by another session.'
          )

          process.exit(1)
        }

        if (
          !reconnecting
        ) {
          reconnecting = true

          console.log(
            '[CONNECTION] Reconnecting in 3 seconds...'
          )

          await sleep(3000)

          try {
            await createSocket()
          } catch (error) {
            reconnecting = false

            console.error(
              '[CONNECTION] Reconnect failed:',
              error?.message || error
            )

            await sleep(5000)

            try {
              await createSocket()
            } catch (retryError) {
              console.error(
                '[CONNECTION] Retry failed:',
                retryError?.message ||
                  retryError
              )

              process.exit(1)
            }
          }
        }
      }
    }
  )

  sock.ev.on(
    'messages.upsert',
    async event => {
      try {
        await handleMessages(
          sock,
          event,
          {
            plugins,
            messageListeners,
            prefix: PREFIX,
            ownerNumber: OWNER_NUMBER,
            mode: MODE
          }
        )
      } catch (error) {
        console.error(
          '[HANDLER] Message error:',
          error?.message || error
        )
      }
    }
  )

  sock.ev.on(
    'group-participants.update',
    async event => {
      try {
        await handleGroupParticipants(
          sock,
          event,
          {
            plugins,
            groupListeners,
            prefix: PREFIX,
            ownerNumber: OWNER_NUMBER,
            mode: MODE
          }
        )
      } catch (error) {
        console.error(
          '[HANDLER] Group event error:',
          error?.message || error
        )
      }
    }
  )

  return sock
}

async function start() {
  console.log('')
  console.log(
    '╭──────────────────────────╮'
  )
  console.log(
    '│       ʀᴀᴢᴀ-ᴍᴅ sᴛᴀʀᴛɪɴɢ      │'
  )
  console.log(
    '╰──────────────────────────╯'
  )

  console.log(
    `✓ Prefix : ${PREFIX}`
  )

  console.log(
    `✓ Mode   : ${MODE}`
  )

  console.log('')

  if (
    !SESSION_ID &&
    !hasLocalSession()
  ) {
    console.log(
      '[SESSION] No SESSION_ID configured.'
    )

    if (
      process.stdin.isTTY
    ) {
      const number =
        await askPairingNumber()

      if (!number) {
        console.error(
          '[SESSION] Invalid number.'
        )

        process.exit(1)
      }

      console.log(
        `[PAIRING] Number: ${number}`
      )

      console.log(
        '[PAIRING] Generate your session token from the pairing website.'
      )
    } else {
      console.error(
        '[SESSION] SESSION_ID is required on Heroku.'
      )

      process.exit(1)
    }
  }

  await createSocket()
}

process.on(
  'uncaughtException',
  error => {
    console.error(
      '[FATAL] Uncaught exception:',
      error?.stack || error
    )
  }
)

process.on(
  'unhandledRejection',
  error => {
    console.error(
      '[FATAL] Unhandled rejection:',
      error?.stack || error
    )
  }
)

start().catch(
  error => {
    console.error(
      '[FATAL] Startup failed:',
      error?.stack || error
    )

    process.exit(1)
  }
)
