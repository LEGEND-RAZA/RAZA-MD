import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'

import {
  makeWASocket,
  Browsers,
  DisconnectReason,
  useMultiFileAuthState
} from '@whiskeysockets/baileys'

import { Boom } from '@hapi/boom'
import P from 'pino'

import {
  loadPlugins,
  plugins,
  messageListeners,
  groupListeners
} from './plugins.js'

import {
  handleMessages,
  handleGroupParticipants
} from './handler.js'

const ROOT =
  process.cwd()

const SESSION_DIR =
  path.join(
    ROOT,
    'session'
  )

const PLUGIN_DIR =
  path.join(
    ROOT,
    'plugins'
  )

const PREFIX =
  process.env.PREFIX || '.'

const SESSION_ID =
  String(
    process.env.SESSION_ID || ''
  ).trim()

const PAIR_SERVER_URL =
  String(
    process.env.PAIR_SERVER_URL || ''
  ).replace(
    /\/+$/,
    ''
  )

const OWNER_NUMBER =
  String(
    process.env.OWNER_NUMBER || ''
  )
    .replace(
      /\D/g,
      ''
    )

const logger =
  P({
    level:
      process.env.LOG_LEVEL ||
      'silent'
  })

let sock = null
let reconnecting = false
let starting = false

let restoredRemoteSession =
  false

function delay(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  )
}

function ensureDirectories() {
  if (
    !fs.existsSync(
      SESSION_DIR
    )
  ) {
    fs.mkdirSync(
      SESSION_DIR,
      {
        recursive:
          true
      }
    )
  }

  if (
    !fs.existsSync(
      PLUGIN_DIR
    )
  ) {
    fs.mkdirSync(
      PLUGIN_DIR,
      {
        recursive:
          true
      }
    )
  }
}

function isShortSession(
  value
) {
  return /^RAZA_[A-Za-z0-9_-]{10,100}$/
    .test(
      String(
        value || ''
      ).trim()
    )
}

function isLegacySession(
  value
) {
  return String(
    value || ''
  )
    .trim()
    .startsWith(
      'RAZA~'
    )
}

function safeFileName(
  name
) {
  if (
    typeof name !==
    'string'
  ) {
    return false
  }

  if (
    !name ||
    path.basename(
      name
    ) !== name
  ) {
    return false
  }

  if (
    name.includes(
      '..'
    ) ||
    name.includes(
      '/'
    ) ||
    name.includes(
      '\\'
    )
  ) {
    return false
  }

  return true
}

function decodeBase64(
  value
) {
  if (
    typeof value !==
    'string'
  ) {
    throw new Error(
      'Invalid session file data'
    )
  }

  return Buffer.from(
    value,
    'base64'
  )
}

async function restoreRemoteSession(
  token
) {
  if (
    !PAIR_SERVER_URL
  ) {
    throw new Error(
      'PAIR_SERVER_URL is missing'
    )
  }

  const url =
    `${PAIR_SERVER_URL}/api/session/${encodeURIComponent(token)}`

  console.log(
    '[SESSION] Fetching remote session...'
  )

  const response =
    await fetch(
      url,
      {
        method:
          'GET',

        headers: {
          Accept:
            'application/json'
        },

        signal:
          AbortSignal.timeout(
            60000
          )
      }
    )

  if (
    !response.ok
  ) {
    let message =
      `Session server returned HTTP ${response.status}`

    try {
      const data =
        await response.json()

      if (
        data?.error
      ) {
        message =
          data.error
      }
    } catch {}

    throw new Error(
      message
    )
  }

  const data =
    await response.json()

  if (
    !data?.success
  ) {
    throw new Error(
      data?.error ||
      'Remote session request failed'
    )
  }

  if (
    !data?.files ||
    typeof data.files !==
      'object'
  ) {
    throw new Error(
      'Remote session contains no auth files'
    )
  }

  const names =
    Object.keys(
      data.files
    )

  if (
    !names.length
  ) {
    throw new Error(
      'Remote session is empty'
    )
  }

  /*
   * Clear old session files
   * before restoring the new one.
   */

  fs.mkdirSync(
    SESSION_DIR,
    {
      recursive:
        true
    }
  )

  for (
    const name of names
  ) {
    if (
      !safeFileName(
        name
      )
    ) {
      throw new Error(
        `Unsafe session filename: ${name}`
      )
    }

    const buffer =
      decodeBase64(
        data.files[name]
      )

    fs.writeFileSync(
      path.join(
        SESSION_DIR,
        name
      ),
      buffer
    )
  }

  restoredRemoteSession =
    true

  console.log(
    `[SESSION] Restored ${names.length} auth files.`
  )
}

function restoreLegacySession(
  session
) {
  /*
   * Supports the old:
   *
   * RAZA~base64-json
   *
   * format.
   */

  const encoded =
    String(
      session
    ).slice(
      5
    )

  if (
    !encoded
  ) {
    throw new Error(
      'Legacy RAZA session is empty'
    )
  }

  let json

  try {
    json =
      Buffer.from(
        encoded,
        'base64url'
      ).toString(
        'utf8'
      )
  } catch {
    json =
      Buffer.from(
        encoded,
        'base64'
      ).toString(
        'utf8'
      )
  }

  const data =
    JSON.parse(
      json
    )

  if (
    !data ||
    typeof data !==
      'object'
  ) {
    throw new Error(
      'Invalid legacy session'
    )
  }

  const files =
    data.files ||
    data.auth ||
    data

  if (
    !files ||
    typeof files !==
      'object'
  ) {
    throw new Error(
      'Legacy session contains no files'
    )
  }

  fs.mkdirSync(
    SESSION_DIR,
    {
      recursive:
        true
    }
  )

  let count = 0

  for (
    const [
      name,
      value
    ] of Object.entries(
      files
    )
  ) {
    if (
      !safeFileName(
        name
      )
    ) {
      continue
    }

    let buffer

    if (
      typeof value ===
      'string'
    ) {
      buffer =
        Buffer.from(
          value,
          'base64'
        )
    } else {
      buffer =
        Buffer.from(
          JSON.stringify(
            value
          )
        )
    }

    fs.writeFileSync(
      path.join(
        SESSION_DIR,
        name
      ),
      buffer
    )

    count++
  }

  if (
    !count
  ) {
    throw new Error(
      'No valid files found in legacy session'
    )
  }

  console.log(
    `[SESSION] Restored ${count} legacy auth files.`
  )
}

async function prepareSession() {
  ensureDirectories()

  /*
   * If a local auth state already exists,
   * use it first.
   */

  const localFiles =
    fs.readdirSync(
      SESSION_DIR
    )

  const hasLocalAuth =
    localFiles.some(
      file =>
        file ===
          'creds.json' ||
        file.startsWith(
          'app-state-sync-key'
        ) ||
        file.startsWith(
          'pre-key'
        )
    )

  /*
   * RAZA_xxx = fetch from pairing server.
   */

  if (
    isShortSession(
      SESSION_ID
    )
  ) {
    /*
     * Don't download it again if
     * the local session is already
     * complete.
     */

    if (
      !hasLocalAuth
    ) {
      await restoreRemoteSession(
        SESSION_ID
      )
    } else {
      console.log(
        '[SESSION] Local session found.'
      )

      console.log(
        '[SESSION] Using local auth state.'
      )
    }

    return
  }

  /*
   * Old RAZA~ session support.
   */

  if (
    isLegacySession(
      SESSION_ID
    ) &&
    !hasLocalAuth
  ) {
    restoreLegacySession(
      SESSION_ID
    )

    return
  }

  /*
   * Empty SESSION_ID:
   * use local session or pairing.
   */

  if (
    SESSION_ID
  ) {
    console.log(
      '[SESSION] Unknown SESSION_ID format.'
    )

    console.log(
      '[SESSION] Using local auth state if available.'
    )
  }

  if (
    hasLocalAuth
  ) {
    console.log(
      '[SESSION] Local auth state found.'
    )
  } else {
    console.log(
      '[SESSION] No existing session found.'
    )
  }
}

function askPairingNumber() {
  return new Promise(
    resolve => {
      const rl =
        readline.createInterface({
          input:
            process.stdin,

          output:
            process.stdout
        })

      rl.question(
        '\nEnter WhatsApp number with country code: ',
        answer => {
          rl.close()

          resolve(
            String(
              answer || ''
            )
              .replace(
                /\D/g,
                ''
              )
          )
        }
      )
    }
  )
}

async function ensurePairing(
  state,
  saveCreds
) {
  if (
    state.creds.registered
  ) {
    return
  }

  let number =
    String(
      process.env.PAIRING_NUMBER ||
        ''
    ).replace(
      /\D/g,
      ''
    )

  if (
    !number
  ) {
    number =
      await askPairingNumber()
  }

  if (
    number.length < 7 ||
    number.length > 15
  ) {
    throw new Error(
      'Invalid WhatsApp number'
    )
  }

  console.log(
    '\n[PAIR] Requesting pairing code...'
  )

  await delay(
    2000
  )

  try {
    const code =
      await sock.requestPairingCode(
        number
      )

    console.log(
      `\n[PAIRING CODE] ${code}`
    )

    console.log(
      '[PAIR] Open WhatsApp > Linked devices > Link a device > Link with phone number'
    )

    /*
     * Keep credentials listener alive.
     */

    sock.ev.on(
      'creds.update',
      saveCreds
    )
  } catch (error) {
    console.error(
      '[PAIR ERROR]',
      error?.message ||
        error
    )

    throw error
  }
}

async function sendStartMessage() {
  if (
    !sock?.user
  ) {
    return
  }

  const jid =
    sock.user.id

  const message =
    [
      '𝐇ᴇʟʟᴏ 𝐓ʜᴇʀᴇ 𝐑ᴀᴢᴀ-𝐌ᴅ 𝐔ꜱᴇʀ!',
      '',
      '> 𝐌ᴜʟᴛɪ-𝐃ᴇᴠɪᴄᴇ 𝐖ʜᴀᴛꜱᴀᴘᴘ 𝐁ᴏᴛ 𝐋ᴏᴀᴅᴇᴅ',
      '',
      `> 𝐏ʀᴇғɪx : [${PREFIX}]`,
      `> 𝐌ᴏᴅᴇ : ${process.env.MODE || 'private'}`,
      `> 𝐑ᴀᴍ : ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`,
      '',
      '𝐓ʜᴀɴᴋꜱ 𝐅ᴏʀ 𝐔ꜱɪɴɢ 𝐑ᴀᴢᴀ-𝐌ᴅ',
      '𝐏ᴏᴡᴇʀᴇᴅ 𝐁ʏ 𝐋ᴇɢᴇɴᴅ 𝐑ᴀᴢᴀ'
    ].join(
      '\n'
    )

  try {
    await sock.sendMessage(
      jid,
      {
        text:
          message
      }
    )
  } catch {}
}

async function startBot() {
  if (
    starting
  ) {
    return
  }

  starting =
    true

  try {
    await prepareSession()

    const {
      state,
      saveCreds
    } =
      await useMultiFileAuthState(
        SESSION_DIR
      )

    sock =
      makeWASocket({
        auth:
          state,

        browser:
          Browsers.macOS(
            'Chrome'
          ),

        printQRInTerminal:
          false,

        logger,

        markOnlineOnConnect:
          process.env.ALWAYS_ONLINE ===
          'true',

        syncFullHistory:
          false,

        generateHighQualityLinkPreview:
          false,

        connectTimeoutMs:
          60000,

        defaultQueryTimeoutMs:
          60000,

        keepAliveIntervalMs:
          30000,

        fireInitQueries:
          true,

        shouldIgnoreJid:
          jid =>
            jid ===
            'status@broadcast'
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
            '[WHATSAPP] Connecting...'
          )
        }

        if (
          connection ===
          'open'
        ) {
          console.log(
            '\n[WHATSAPP] Connected successfully.'
          )

          console.log(
            `[WHATSAPP] ${sock.user?.id || 'unknown'}`
          )

          reconnecting =
            false

          starting =
            false

          /*
           * Send startup message
           * only for an already
           * authenticated session.
           */

          if (
            state.creds.registered
          ) {
            await sendStartMessage()
          }
        }

        if (
          connection ===
          'close'
        ) {
          const statusCode =
            new Boom(
              lastDisconnect?.error
            )
              ?.output
              ?.statusCode

          console.log(
            `[WHATSAPP] Connection closed: ${
              statusCode ||
              'unknown'
            }`
          )

          starting =
            false

          if (
            statusCode ===
            DisconnectReason.loggedOut
          ) {
            console.log(
              '[WHATSAPP] Session logged out.'
            )

            return
          }

          if (
            statusCode ===
            DisconnectReason.badSession
          ) {
            console.log(
              '[WHATSAPP] Bad session.'
            )

            return
          }

          if (
            !reconnecting
          ) {
            reconnecting =
              true

            console.log(
              '[WHATSAPP] Reconnecting in 3 seconds...'
            )

            setTimeout(
              () => {
                startBot().catch(
                  error => {
                    console.error(
                      '[RECONNECT ERROR]',
                      error?.message ||
                        error
                    )
                  }
                )
              },
              3000
            )
          }
        }
      }
    )

    /*
     * ==========================
     * MESSAGE HANDLER
     * ==========================
     */

    sock.ev.on(
      'messages.upsert',
      async ({
        messages,
        type
      }) => {
        try {
          if (
            type !==
            'notify'
          ) {
            return
          }

          for (
            const message
            of messages
          ) {
            if (
              !message?.message
            ) {
              continue
            }

            try {
              await handleMessages(
                sock,
                message,
                plugins,
                messageListeners
              )
            } catch (
              error
            ) {
              console.error(
                '[MESSAGE ERROR]',
                error?.message ||
                  error
              )
            }
          }
        } catch (
          error
        ) {
          console.error(
            '[UPsert ERROR]',
            error?.message ||
              error
          )
        }
      }
    )

    /*
     * ==========================
     * GROUP PARTICIPANTS
     * ==========================
     */

    sock.ev.on(
      'group-participants.update',
      async update => {
        try {
          await handleGroupParticipants(
            sock,
            update,
            groupListeners
          )
        } catch (
          error
        ) {
          console.error(
            '[GROUP EVENT ERROR]',
            error?.message ||
              error
          )
        }
      }
    )
  } catch (error) {
    starting =
      false

    console.error(
      '\n[FATAL]',
      error?.message ||
        error
    )

    if (
      !reconnecting
    ) {
      reconnecting =
        true

      setTimeout(
        () => {
          startBot().catch(
            console.error
          )
        },
        5000
      )
    }
  }
}

async function main() {
  console.log(
    '\n╭────────────────────────────╮'
  )

  console.log(
    '│       ʀᴀᴢᴀ-ᴍᴅ ʙᴏᴛ         │'
  )

  console.log(
    '╰────────────────────────────╯\n'
  )

  console.log(
    `[CONFIG] Prefix: ${PREFIX}`
  )

  if (
    isShortSession(
      SESSION_ID
    )
  ) {
    console.log(
      '[CONFIG] Short remote session detected.'
    )
  }

  if (
    PAIR_SERVER_URL
  ) {
    console.log(
      `[CONFIG] Pair server: ${PAIR_SERVER_URL}`
    )
  }

  await loadPlugins()

  console.log(
    `[PLUGINS] ${plugins.size} commands loaded.`
  )

  console.log(
    `[PLUGINS] ${messageListeners.length} message listeners loaded.`
  )

  console.log(
    `[PLUGINS] ${groupListeners.length} group listeners loaded.`
  )

  await startBot()
}

process.on(
  'uncaughtException',
  error => {
    console.error(
      '[UNCAUGHT]',
      error?.message ||
        error
    )
  }
)

process.on(
  'unhandledRejection',
  error => {
    console.error(
      '[UNHANDLED]',
      error?.message ||
        error
    )
  }
)

process.on(
  'SIGTERM',
  async () => {
    console.log(
      '[SYSTEM] Shutting down...'
    )

    try {
      sock?.end(
        undefined
      )
    } catch {}

    process.exit(
      0
    )
  }
)

process.on(
  'SIGINT',
  async () => {
    console.log(
      '[SYSTEM] Shutting down...'
    )

    try {
      sock?.end(
        undefined
      )
    } catch {}

    process.exit(
      0
    )
  }
)

main().catch(
  error => {
    console.error(
      '[STARTUP ERROR]',
      error?.message ||
        error
    )

    process.exit(
      1
    )
  }
)
