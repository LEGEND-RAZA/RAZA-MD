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

const ROOT = process.cwd()
const SESSION_DIR = path.join(ROOT, 'session')
const PREFIX = process.env.PREFIX || '.'

const logger = P({
  level: 'silent'
})

let sock
let reconnecting = false
let startMessageSent = false

/**
 * Restores creds.json from process.env.SESSION_ID with multi-source fallback
 */
async function initSession() {
  const credsPath = path.join(SESSION_DIR, 'creds.json')
  
  if (fs.existsSync(credsPath)) return

  const sessionId = process.env.SESSION_ID
  if (!sessionId) {
    console.error('[-] Error: SESSION_ID environment variable is missing!')
    return
  }

  try {
    await fs.promises.mkdir(SESSION_DIR, { recursive: true })
    let code = sessionId.trim()

    if (code.startsWith('levanter_') || code.startsWith('session_')) {
      code = code.replace(/^(levanter_|session_)/, '')
    }

    let sessionData = ''

    // 1. Direct JSON String
    if (code.startsWith('{')) {
      sessionData = code
    }

    // 2. Base64 Encoded Session
    if (!sessionData) {
      try {
        const decoded = Buffer.from(code, 'base64').toString('utf-8').trim()
        if (decoded.startsWith('{')) {
          sessionData = decoded
        }
      } catch {}
    }

    // 3. Direct URL Fetch
    if (!sessionData && code.includes('://')) {
      const res = await fetch(code)
      sessionData = await res.text()
    }

    // 4. Remote Session Endpoints
    if (!sessionData) {
      const endpoints = [
        `https://paste.c-s.in/raw/${code}`,
        `https://pastebin.com/raw/${code}`,
        `https://session.levanter.site/session?id=${code}`
      ]

      for (const url of endpoints) {
        try {
          const res = await fetch(url)
          const text = (await res.text()).trim()
          if (text.startsWith('{')) {
            sessionData = text
            break
          }
        } catch {}
      }
    }

    if (!sessionData) {
      throw new Error('Invalid or expired SESSION_ID. Could not fetch valid JSON credentials.')
    }

    // Validate JSON structure before saving
    JSON.parse(sessionData)
    await fs.promises.writeFile(credsPath, sessionData, 'utf-8')
    console.log('[+] SESSION_ID successfully loaded and restored.')
  } catch (error) {
    console.error('[-] Failed to decode/parse SESSION_ID:', error?.message || error)
  }
}

async function sendStartMessage() {
  if (!sock?.user?.id) {
    console.log('[!] Bot JID not available.')
    return
  }

  if (startMessageSent) return

  try {
    const botJid = jidNormalizedUser(sock.user.id)

    if (!botJid) {
      console.log('[!] Could not determine bot JID.')
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

    await sock.sendMessage(botJid, { text: startMessage })
    startMessageSent = true

    console.log(`[OK] Active message sent to bot: ${botJid}`)
  } catch (error) {
    console.error('[!] Active message error:', error?.message || error)
  }
}

async function startBot() {
  if (reconnecting) return
  reconnecting = true

  try {
    // Load and restore credentials from SESSION_ID environment variable
    await initSession()

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR)

    sock = makeWASocket({
      auth: state,
      browser: Browsers.ubuntu('Chrome'),
      logger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      badSessionDeleteHistory: true
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('messages.upsert', (update) =>
      handleMessages(update, sock, plugins, messageListeners)
    )

    sock.ev.on('group-participants.update', (update) =>
      handleGroupParticipants(update, sock, groupListeners)
    )

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (connection === 'connecting') {
        console.log('[...] Connecting Raza-MD to WhatsApp...')
      }

      if (connection === 'open') {
        reconnecting = false

        console.log('')
        console.log('╭━━━〔 𝐑ᴀᴢᴀ-𝐌ᴅ 〕━━━┈⊷')
        console.log('┃ 𝐌ᴜʟᴛɪ-𝐃ᴇᴠɪᴄᴇ 𝐖ʜᴀᴛsᴀᴘᴘ 𝐁ᴏᴛ')
        console.log('┃ 𝐒ᴛᴀᴛᴜs : 𝐎ɴʟɪɴᴇ ✅')
        console.log(`┃ 𝐏ʀᴇғɪx : ${PREFIX}`)
        console.log(`┃ 𝐂ᴏᴍᴍᴀɴᴅs : ${plugins.size}`)
        console.log(`┃ 𝐏ʟᴜɢɪɴs : ${new Set([...plugins.values()]).size}`)
        console.log('┃ 𝐏ᴏᴡᴇʀᴇᴅ 𝐁ʏ : 𝐋ᴇɢᴇɴᴅ 𝐑ᴀᴢᴀ')
        console.log('╰━━━━━━━━━━━━━━━━━━━━┈⊷')
        console.log('')

        await sendStartMessage()
      }

      if (connection === 'close') {
        reconnecting = false

        const code = new Boom(lastDisconnect?.error)?.output?.statusCode
        const loggedOut = code === DisconnectReason.loggedOut

        console.log(`[-] Connection closed. Code: ${code ?? 'unknown'}`)

        if (loggedOut) {
          console.log('[!] Session was logged out. Please update your SESSION_ID env variable.')
          return
        }

        console.log('[...] Reconnecting in 3 seconds...')
        setTimeout(startBot, 3000)
      }
    })
  } catch (error) {
    reconnecting = false
    console.error('Startup error:', error)
    setTimeout(startBot, 5000)
  }
}

await loadPlugins()
await startBot()
