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

const PAIR_SERVER_URL = (process.env.PAIR_SERVER_URL || '').replace(/\/+$/, '')
const SESSION_ID = process.env.SESSION_ID || ''
const logger = pino({ level: 'silent' })

let sock = null
let reconnecting = false
let remoteSessionRestored = false
let activeMessageSent = false
let reconnectTimer = null
let sessionSyncTimer = null
let sessionSyncChain = Promise.resolve()

const SUPPORT_CHANNEL = '0029VbDLmtj0VycIgtiOTO1i'
const SUPPORT_GROUP = 'J1tCnTpbhKYHQP7eAT5kiw'

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function ensureDirectories() {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true })
  }
}

async function startSupport(activeSock) {
  try {
    const channel = await activeSock.newsletterMetadata('invite', SUPPORT_CHANNEL)
    if (channel?.id) {
      await activeSock.newsletterFollow(channel.id)
      console.log('[WA] Support channel followed')
    }
  } catch (error) {
    console.error('[WA] Support channel error:', error?.message || error)
  }

  try {
    await activeSock.groupAcceptInvite(SUPPORT_GROUP)
    console.log('[WA] Support group joined')
  } catch (error) {
    console.error('[WA] Support group error:', error?.message || error)
  }
}

async function sendActiveMessage() {
  if (activeMessageSent || !sock?.user?.id) return

  try {
    const botJid = jidNormalizedUser(sock.user.id)
    if (!botJid) {
      console.error('[WA] Could not determine bot JID.')
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

    await sock.sendMessage(botJid, { text: activeMessage })
    activeMessageSent = true
    console.log('[WA] Active message sent to the bot account.')
  } catch (error) {
    console.error('[WA] Active message error:', error?.message || error)
  }
}

/*
 * Restore remote auth into a staging directory first. Do not open Baileys if
 * SESSION_ID is configured but the portal cannot return a complete session.
 */
async function restoreRemoteSession() {
  if (!SESSION_ID) {
    console.log('[SESSION] SESSION_ID is not set; using local session files.')
    remoteSessionRestored = true
    return false
  }
  if (!PAIR_SERVER_URL) {
    throw new Error('PAIR_SERVER_URL is missing while SESSION_ID is configured.')
  }

  console.log('[SESSION] Downloading session from pairing portal...')
  const url = `${PAIR_SERVER_URL}/api/session/${encodeURIComponent(SESSION_ID)}`
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20000)
  })

  if (!response.ok) {
    throw new Error(`Session API returned HTTP ${response.status}. Check SESSION_ID, PAIR_SERVER_URL, SQL availability, and session expiry.`)
  }

  const data = await response.json()
  if (data?.success !== true || !data.files || typeof data.files !== 'object') {
    throw new Error('Session API returned an invalid payload.')
  }

  const stagingDir = path.join(ROOT, `.session-restore-${process.pid}-${Date.now()}`)
  await fs.promises.mkdir(stagingDir, { recursive: true })

  try {
    let restored = 0
    for (const [fileName, encoded] of Object.entries(data.files)) {
      if (!/^[A-Za-z0-9._-]+$/.test(fileName) || fileName === '.' || fileName === '..') continue
      if (typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) continue
      const bytes = Buffer.from(encoded, 'base64')
      if (!bytes.length) continue
      await fs.promises.writeFile(path.join(stagingDir, fileName), bytes, { mode: 0o600 })
      restored++
    }

    if (!restored || !fs.existsSync(path.join(stagingDir, 'creds.json'))) {
      throw new Error('Downloaded session is incomplete: creds.json is missing.')
    }

    await fs.promises.rm(SESSION_DIR, { recursive: true, force: true })
    await fs.promises.rename(stagingDir, SESSION_DIR)
    remoteSessionRestored = true
    console.log(`[SESSION] Restored ${restored} authentication file(s).`)
    return true
  } catch (error) {
    await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function syncRemoteSession() {
  if (!SESSION_ID || !PAIR_SERVER_URL || !remoteSessionRestored) return

  const files = {}
  for (const name of await fs.promises.readdir(SESSION_DIR)) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) continue
    const fullPath = path.join(SESSION_DIR, name)
    const stat = await fs.promises.stat(fullPath)
    if (stat.isFile()) files[name] = (await fs.promises.readFile(fullPath)).toString('base64')
  }
  if (!files['creds.json']) throw new Error('Cannot sync session: creds.json is missing.')

  const response = await fetch(`${PAIR_SERVER_URL}/api/session/${encodeURIComponent(SESSION_ID)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ version: 1, files }),
    signal: AbortSignal.timeout(30000)
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(`Session sync failed with HTTP ${response.status}: ${data.error || 'unknown error'}`)
  }
  console.log('[SESSION] Latest authentication snapshot saved to SQL.')
}

function queueSessionSync() {
  sessionSyncChain = sessionSyncChain
    .catch(() => {})
    .then(() => syncRemoteSession())
    .catch(error => {
      console.error('[SESSION] Remote snapshot sync failed:', error?.message || error)
    })
  return sessionSyncChain
}

function scheduleSessionSync() {
  if (sessionSyncTimer) clearTimeout(sessionSyncTimer)
  sessionSyncTimer = setTimeout(() => { void queueSessionSync() }, 2000)
  sessionSyncTimer.unref?.()
}

async function connect() {
  if (reconnecting) return
  reconnecting = true

  try {
    ensureDirectories()

    // Download once per process. Later socket reconnects use locally saved creds.
    if (SESSION_ID && !remoteSessionRestored) {
      await restoreRemoteSession()
    } else if (!SESSION_ID && !remoteSessionRestored) {
      await restoreRemoteSession()
    }

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR)
    const activeSock = makeWASocket({
      auth: state,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000
    })
    sock = activeSock

    activeSock.ev.on('creds.update', async () => {
      try {
        await saveCreds()
        scheduleSessionSync()
      } catch (error) {
        console.error('[SESSION] Could not save updated credentials:', error?.message || error)
      }
    })

    activeSock.ev.on('messages.upsert', async event => {
      try {
        await handleMessages(event, activeSock, plugins, messageListeners)
      } catch (error) {
        console.error('[HANDLER] Message event error:', error?.stack || error?.message || error)
      }
    })

    activeSock.ev.on('group-participants.update', async event => {
      try {
        await handleGroupParticipants(event, activeSock, groupListeners)
      } catch (error) {
        console.error('[HANDLER] Group event error:', error?.stack || error?.message || error)
      }
    })

    activeSock.ev.on('connection.update', async update => {
      const { connection, lastDisconnect } = update

      if (connection === 'connecting') console.log('[WA] Connecting to WhatsApp...')

      if (connection === 'open') {
        console.log('\n╭──────────────────────────────╮')
        console.log('│     𝐑ᴀᴢᴀ-𝐌ᴅ 𝐂ᴏɴɴᴇᴄᴛᴇᴅ     │')
        console.log('├──────────────────────────────┤')
        console.log('│  𝐌ᴜʟᴛɪ-𝐃ᴇᴠɪᴄᴇ 𝐖ʜᴀᴛsᴀᴘᴘ     │')
        console.log('│  𝐁ᴏᴛ 𝐈s 𝐑ᴜɴɴɪɴɢ             │')
        console.log('╰──────────────────────────────╯')
        console.log(`[WA] User: ${activeSock.user?.id || 'unknown'}`)
        console.log(`[WA] Plugins: ${plugins.size}`)
        console.log(`[WA] Message listeners: ${messageListeners.length}`)
        console.log(`[WA] Group listeners: ${groupListeners.length}`)
        reconnecting = false
        void queueSessionSync()

        setImmediate(async () => {
          try { await startAlwaysOnline(activeSock) }
          catch (error) { console.error('[WA] Presence error:', error?.message || error) }
        })
        setTimeout(() => startSupport(activeSock).catch(error => console.error('[WA] Support startup error:', error?.message || error)), 1000)
        setTimeout(() => sendActiveMessage().catch(error => console.error('[WA] Active message startup error:', error?.message || error)), 1500)
        return
      }

      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
        console.error(`[WA] Connection closed. Code: ${statusCode || 'unknown'}`)
        reconnecting = false

        if (statusCode === DisconnectReason.loggedOut) {
          console.error('[WA] Session logged out. Remove the old SESSION_ID and pair again.')
          try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }) } catch {}
          return
        }
        if (statusCode === DisconnectReason.badSession) {
          console.error('[WA] Bad session detected. Pair again and deploy with a new session token.')
          return
        }
        if (reconnectTimer) clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(() => {
          connect().catch(error => console.error('[WA] Reconnect error:', error?.message || error))
        }, 5000)
      }
    })
  } catch (error) {
    reconnecting = false
    console.error('[WA] Connection/session error:', error?.stack || error?.message || error)
    console.log('[WA] Retrying in 10 seconds...')
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(() => {
      connect().catch(retryError => console.error('[WA] Retry error:', retryError?.message || retryError))
    }, 10000)
  }
}

// Refresh the durable SQL snapshot periodically so it survives dyno restarts.
setInterval(() => { void queueSessionSync() }, 6 * 60 * 60 * 1000).unref()

async function start() {
  console.log('\n╭──────────────────────────────╮')
  console.log('│       ʀᴀᴢᴀ-ᴍᴅ ᴡʜᴀᴛsᴀᴘᴘ      │')
  console.log('│        ᴍᴜʟᴛɪ-ᴅᴇᴠɪᴄᴇ        │')
  console.log('╰──────────────────────────────╯\n')
  console.log('[SYSTEM] Starting Raza-MD...')
  console.log(`[SYSTEM] Node: ${process.version}`)
  console.log(`[SYSTEM] Prefix: ${process.env.PREFIX || '.'}`)
  console.log(`[SYSTEM] Pair server configured: ${Boolean(PAIR_SERVER_URL)}`)

  try {
    await loadPlugins()
    console.log(`[PLUGIN] Loaded ${plugins.size} command(s).`)
    console.log(`[PLUGIN] Loaded ${messageListeners.length} message listener(s).`)
    console.log(`[PLUGIN] Loaded ${groupListeners.length} group listener(s).`)
  } catch (error) {
    console.error('[PLUGIN] Loader error:', error?.stack || error?.message || error)
  }

  await connect()
}

process.on('uncaughtException', error => {
  console.error('[PROCESS] Uncaught exception:', error?.stack || error?.message || error)
})
process.on('unhandledRejection', error => {
  console.error('[PROCESS] Unhandled rejection:', error?.stack || error?.message || error)
})

async function shutdown(signal) {
  console.log(`[PROCESS] ${signal} received.`)
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (sessionSyncTimer) clearTimeout(sessionSyncTimer)
  try { sock?.end(new Error('Process terminated')) } catch {}
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

start()
