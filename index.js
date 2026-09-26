import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
  jidNormalizedUser
} from '@whiskeysockets/baileys'

import P from 'pino'
import { Boom } from '@hapi/boom'
import path from 'node:path'
import fs from 'node:fs'

import {
  handleMessages,
  handleGroupParticipants
} from './handler.js'

import {
  plugins,
  messageListeners,
  groupListeners,
  loadPlugins
} from './lib/plugin-loader.js'

const ROOT =
  process.cwd()

const SESSION_DIR =
  path.join(
    ROOT,
    'session'
  )

const PREFIX =
  process.env.PREFIX || '.'

const logger =
  P({
    level: 'silent'
  })

let sock
let reconnecting = false
let startMessageSent = false

/*
 * ==============================
 * SESSION RESTORE
 * ==============================
 */

async function initSession() {
  const credsPath =
    path.join(
      SESSION_DIR,
      'creds.json'
    )

  if (
    fs.existsSync(credsPath)
  ) {
    console.log(
      '[+] Existing session found.'
    )
    return
  }

  const sessionId =
    process.env.SESSION_ID

  if (
    !sessionId
  ) {
    console.error(
      '[-] Error: SESSION_ID environment variable is missing!'
    )
    return
  }

  try {
    await fs.promises.mkdir(
      SESSION_DIR,
      {
        recursive: true
      }
    )

    let code =
      sessionId.trim()

    /*
     * Remove old session prefixes.
     */
    code =
      code.replace(
        /^(levanter_|session_)/i,
        ''
      )

    /*
     * ==============================
     * RAZA~ MULTI-FILE SESSION
     * ==============================
     */

    if (
      code.startsWith(
        'RAZA~'
      )
    ) {
      console.log(
        '[...] RAZA session detected. Restoring session files...'
      )

      const encoded =
        code.slice(5)

      let decoded

      try {
        decoded =
          Buffer.from(
            encoded,
            'base64url'
          ).toString(
            'utf8'
          )
      } catch {
        throw new Error(
          'Invalid RAZA session encoding.'
        )
      }

      let sessionData

      try {
        sessionData =
          JSON.parse(
            decoded
          )
      } catch {
        throw new Error(
          'Invalid RAZA session JSON.'
        )
      }

      if (
        !sessionData ||
        typeof sessionData !== 'object'
      ) {
        throw new Error(
          'Invalid RAZA session data.'
        )
      }

      if (
        sessionData.version !== 1
      ) {
        throw new Error(
          'Unsupported RAZA session version.'
        )
      }

      if (
        !sessionData.files ||
        typeof sessionData.files !== 'object'
      ) {
        throw new Error(
          'RAZA session contains no auth files.'
        )
      }

      let restored =
        0

      for (
        const [
          name,
          value
        ] of Object.entries(
          sessionData.files
        )
      ) {
        /*
         * Only allow simple filenames.
         * Prevents path traversal.
         */
        if (
          path.basename(name) !==
          name
        ) {
          continue
        }

        if (
          typeof value !==
          'string'
        ) {
          continue
        }

        const filePath =
          path.join(
            SESSION_DIR,
            name
          )

        let buffer

        try {
          buffer =
            Buffer.from(
              value,
              'base64'
            )
        } catch {
          continue
        }

        await fs.promises.writeFile(
          filePath,
          buffer
        )

        restored++
      }

      if (
        restored === 0
      ) {
        throw new Error(
          'No valid files were restored from RAZA session.'
        )
      }

      if (
        !fs.existsSync(
          credsPath
        )
      ) {
        throw new Error(
          'RAZA session restored, but creds.json is missing.'
        )
      }

      console.log(
        `[+] RAZA session restored successfully: ${restored} files.`
      )

      return
    }

    /*
     * ==============================
     * DIRECT JSON SESSION
     * ==============================
     */

    let sessionData = ''

    if (
      code.startsWith('{')
    ) {
      sessionData =
        code
    }

    /*
     * ==============================
     * BASE64 JSON SESSION
     * ==============================
     */

    if (
      !sessionData
    ) {
      try {
        const decoded =
          Buffer.from(
            code,
            'base64'
          ).toString(
            'utf8'
          ).trim()

        if (
          decoded.startsWith('{')
        ) {
          sessionData =
            decoded
        }
      } catch {}
    }

    /*
     * ==============================
     * DIRECT URL SESSION
     * ==============================
     */

    if (
      !sessionData &&
      code.includes('://')
    ) {
      const response =
        await fetch(code)

      if (
        response.ok
      ) {
        sessionData =
          (
            await response.text()
          ).trim()
      }
    }

    /*
     * ==============================
     * REMOTE SESSION ENDPOINTS
     * ==============================
     */

    if (
      !sessionData
    ) {
      const endpoints = [
        `https://paste.c-s.in/raw/${code}`,
        `https://pastebin.com/raw/${code}`,
        `https://session.levanter.site/session?id=${code}`
      ]

      for (
        const url of endpoints
      ) {
        try {
          const response =
            await fetch(url)

          if (
            !response.ok
          ) {
            continue
          }

          const text =
            (
              await response.text()
            ).trim()

          if (
            text.startsWith('{')
          ) {
            sessionData =
              text

            break
          }
        } catch {}
      }
    }

    if (
      !sessionData
    ) {
      throw new Error(
        'Invalid or expired SESSION_ID. Could not fetch valid credentials.'
      )
    }

    /*
     * Validate JSON.
     */
    let parsed

    try {
      parsed =
        JSON.parse(
          sessionData
        )
    } catch {
      throw new Error(
        'SESSION_ID contains invalid JSON.'
      )
    }

    /*
     * Save old-style creds.json.
     */
    await fs.promises.writeFile(
      credsPath,
      JSON.stringify(
        parsed
      ),
      'utf8'
    )

    console.log(
      '[+] SESSION_ID successfully loaded and restored.'
    )
  } catch (error) {
    console.error(
      '[-] Failed to restore SESSION_ID:',
      error?.message ||
        error
    )
  }
}

/*
 * ==============================
 * START MESSAGE
 * ==============================
 */

async function sendStartMessage() {
  if (
    !sock?.user?.id
  ) {
    console.log(
      '[!] Bot JID not available.'
    )

    return
  }

  if (
    startMessageSent
  ) {
    return
  }

  try {
    const botJid =
      jidNormalizedUser(
        sock.user.id
      )

    if (
      !botJid
    ) {
      console.log(
        '[!] Could not determine bot JID.'
      )

      return
    }

    const startMessage = `
𝐇ᴇʟʟᴏ 𝐓ʜᴇʀᴇ 𝐑ᴀᴢᴀ-𝐌ᴅ 𝐔ꜱᴇʀ! 👋

╭━━━〔 𝐑ᴀᴢᴀ-𝐌ᴅ 〕━━━┈⊷
┃
┃ 𝐌ᴜʟᴛɪ-𝐃ᴇᴠɪᴄᴇ 𝐖ʜᴀᴛsᴀᴘᴘ 𝐁ᴏᴛ
┃ 𝐒ᴛᴀᴛᴜs : 𝐎ɴʟɪɴᴇ ✅
┃ 𝐏ʀᴇғɪx : ${PREFIX}
┃ 𝐂ᴏᴍᴍᴀɴᴅs : ${plugins.size}
┃ 𝐏ʟᴜɢɪɴs : ${new Set([...plugins.values()]).size}
┃
╰━━━━━━━━━━━━━━━━━━━━┈⊷

> 𝐌ᴜʟᴛɪ-𝐃ᴇᴠɪᴄᴇ 𝐖ʜᴀᴛsᴀᴘᴘ 𝐁ᴏᴛ 𝐋ᴏᴀᴅᴇᴅ ✅

𝐓ʜᴀɴᴋs 𝐅ᴏʀ 𝐔sɪɴɢ 𝐑ᴀᴢᴀ-𝐌ᴅ 💗

𝐏ᴏᴡᴇʀᴇ𝐷 𝐁ʏ 𝐋ᴇɢᴇɴᴅ 𝐑ᴀᴢᴀ
`.trim()

    await sock.sendMessage(
      botJid,
      {
        text:
          startMessage
      }
    )

    startMessageSent =
      true

    console.log(
      `[OK] Active message sent to bot: ${botJid}`
    )
  } catch (error) {
    console.error(
      '[!] Active message error:',
      error?.message ||
        error
    )
  }
}

/*
 * ==============================
 * START BOT
 * ==============================
 */

async function startBot() {
  if (
    reconnecting
  ) {
    return
  }

  reconnecting =
    true

  try {
    /*
     * Restore SESSION_ID first.
     */
    await initSession()

    /*
     * Load multi-file authentication.
     */
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

        logger,

        markOnlineOnConnect:
          false,

        syncFullHistory:
          false,

        generateHighQualityLinkPreview:
          false,

        badSessionDeleteHistory:
          true,

        connectTimeoutMs:
          60000,

        defaultQueryTimeoutMs:
          60000,

        keepAliveIntervalMs:
          30000
      })

    sock.ev.on(
      'creds.update',
      saveCreds
    )

    sock.ev.on(
      'messages.upsert',
      update =>
        handleMessages(
          update,
          sock,
          plugins,
          messageListeners
        )
    )

    sock.ev.on(
      'group-participants.update',
      update =>
        handleGroupParticipants(
          update,
          sock,
          groupListeners
        )
    )

    sock.ev.on(
      'connection.update',
      async ({
        connection,
        lastDisconnect
      }) => {
        if (
          connection ===
          'connecting'
        ) {
          console.log(
            '[...] Connecting Raza-MD to WhatsApp...'
          )
        }

        if (
          connection ===
          'open'
        ) {
          reconnecting =
            false

          console.log('')

          console.log(
            '╭━━━〔 𝐑ᴀᴢᴀ-𝐌ᴅ 〕━━━┈⊷'
          )

          console.log(
            '┃ 𝐌ᴜʟᴛɪ-𝐃ᴇᴠɪᴄᴇ 𝐖ʜᴀᴛsᴀᴘᴘ 𝐁ᴏᴛ'
          )

          console.log(
            '┃ 𝐒ᴛᴀᴛᴜs : 𝐎ɴʟɪɴᴇ ✅'
          )

          console.log(
            `┃ 𝐏ʀᴇғɪx : ${PREFIX}`
          )

          console.log(
            `┃ 𝐂ᴏᴍᴍᴀɴᴅs : ${plugins.size}`
          )

          console.log(
            `┃ 𝐏ʟᴜɢɪɴs : ${new Set([...plugins.values()]).size}`
          )

          console.log(
            '┃ 𝐏ᴏᴡᴇʀᴇᴅ 𝐁ʏ : 𝐋ᴇɢᴇɴᴅ 𝐑ᴀᴢᴀ'
          )

          console.log(
            '╰━━━━━━━━━━━━━━━━━━━━┈⊷'
          )

          console.log('')

          await sendStartMessage()
        }

        if (
          connection ===
          'close'
        ) {
          reconnecting =
            false

          const code =
            new Boom(
              lastDisconnect?.error
            )
              ?.output
              ?.statusCode

          const loggedOut =
            code ===
            DisconnectReason.loggedOut

          console.log(
            `[-] Connection closed. Code: ${code ?? 'unknown'}`
          )

          if (
            loggedOut
          ) {
            console.log(
              '[!] Session was logged out. Please update your SESSION_ID env variable.'
            )

            return
          }

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
  } catch (error) {
    reconnecting =
      false

    console.error(
      'Startup error:',
      error
    )

    setTimeout(
      startBot,
      5000
    )
  }
}

/*
 * ==============================
 * STARTUP
 * ==============================
 */

await loadPlugins()

await startBot()
