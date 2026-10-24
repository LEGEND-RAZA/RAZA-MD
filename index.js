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
  groupListeners,
  setupHooks
} from './lib/plugin-loader.js'

import {
  handleMessages,
  handleGroupParticipants,
  startAlwaysOnline
} from './handler.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SESSION_DIR = path.join(__dirname, 'session')
const CREDS_FILE = path.join(SESSION_DIR, 'creds.json')

const PAIR_SERVER_URL = (
  process.env.PAIR_SERVER_URL || 'https://pair-web-3e08f4e68faf.herokuapp.com'
).replace(/\/+$/, '')

const SESSION_ID = (process.env.SESSION_ID || '').trim()
const SYNC_MINUTES = Number(process.env.SESSION_SYNC_MINUTES) || 10
const SESSION_URL = `${PAIR_SERVER_URL}/api/session/${encodeURIComponent(SESSION_ID)}`

const logger = pino({ level: 'silent' })

const SUPPORT_CHANNEL = '0029VbDLmtj0VycIgtiOTO1i'
const SUPPORT_GROUP = 'J1tCnTpbhKYHQP7eAT5kiw'

let sock = null
let reconnecting = false
let activeMessageSent = false
let supportDone = false
let syncStarted = false
let syncing = false
let syncOff = false
let lastSig = ''
let forceRestore = false
let sessionRetries = 0
let badSessionRetries = 0
let replacedRetries = 0

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function ensureDirectories() {
  fs.mkdirSync(SESSION_DIR, { recursive: true })
}

function validCredsAt(file) {
  try {
    return Boolean(JSON.parse(fs.readFileSync(file, 'utf8'))?.me?.id)
  } catch {
    return false
  }
}

async function restoreRemoteSession(force = false) {
  if (!force && validCredsAt(CREDS_FILE)) {
    console.log('[SESSION] Using local session.')
    return 'ok'
  }

  if (!SESSION_ID) {
    console.error('[SESSION] SESSION_ID not found.')
    return 'invalid'
  }

  let outcome = 'retry'

  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      console.log(`[SESSION] Restoring remote session (attempt ${attempt})...`)

      const response = await fetch(SESSION_URL, {
        signal: AbortSignal.timeout(30000)
      })
      const data = await response.json().catch(() => ({}))

      if (response.status === 400 || response.status === 404) {
        console.error(`[SESSION] ${data.error || 'Session not found'}. Pair again and redeploy with a new SESSION_ID.`)
        return 'invalid'
      }

      if (!response.ok || !data.files || typeof data.files !== 'object') {
        throw new Error(data.error || `HTTP ${response.status}`)
      }

      const tmp = `${SESSION_DIR}.tmp`
      fs.rmSync(tmp, { recursive: true, force: true })
      fs.mkdirSync(tmp, { recursive: true })

      let restored = 0
      for (const [fileName, encoded] of Object.entries(data.files)) {
        const safeName = path.basename(fileName)
        if (typeof encoded !== 'string' || !safeName || safeName === '.' || safeName === '..') continue
        fs.writeFileSync(path.join(tmp, safeName), Buffer.from(encoded, 'base64'))
        restored++
      }

      if (!restored || !validCredsAt(path.join(tmp, 'creds.json'))) {
        fs.rmSync(tmp, { recursive: true, force: true })
        throw new Error('Downloaded session is incomplete')
      }

      fs.rmSync(SESSION_DIR, { recursive: true, force: true })
      fs.renameSync(tmp, SESSION_DIR)

      console.log(`[SESSION] Remote session restored (${restored} files).`)
      return 'ok'
    } catch (error) {
      outcome = 'retry'
      console.error('[SESSION] Restore error:', error?.message || error)
      await sleep(attempt * 3000)
    }
  }

  return outcome
}

function signature() {
  try {
    return fs
      .readdirSync(SESSION_DIR)
      .map(name => {
        const stat = fs.statSync(path.join(SESSION_DIR, name))
        return `${name}:${stat.size}:${stat.mtimeMs}`
      })
      .join('|')
  } catch {
    return ''
  }
}

async function pushSession() {
  if (!SESSION_ID || syncing || syncOff || !validCredsAt(CREDS_FILE)) return

  syncing = true

  try {
    const sig = signature()
    if (!sig || sig === lastSig) return

    const files = {}
    for (const name of fs.readdirSync(SESSION_DIR)) {
      const file = path.join(SESSION_DIR, name)
      if (fs.statSync(file).isFile()) {
        files[name] = fs.readFileSync(file).toString('base64')
      }
    }

    const response = await fetch(SESSION_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files }),
      signal: AbortSignal.timeout(30000)
    })

    if (response.ok) {
      lastSig = sig
      console.log('[SESSION] Synced to server.')
    } else if (response.status === 404 || response.status === 405) {
      syncOff = true
      console.error('[SESSION] Server does not accept session updates. Sync disabled.')
    } else {
      const body = await response.text().catch(() => '')
      console.error(`[SESSION] Sync failed: HTTP ${response.status} — ${body.slice(0, 200)}`)
    }
  } catch (error) {
    console.error('[SESSION] Sync error:', error?.message || error)
  } finally {
    syncing = false
  }
}

function startSessionSync() {
  if (syncStarted || !SESSION_ID) return
  syncStarted = true
  setTimeout(pushSession, 60 * 1000).unref()
  setInterval(pushSession, SYNC_MINUTES * 60 * 1000).unref()
}

async function startSupport(sock) {
  if (supportDone) return
  supportDone = true

  try {
    const channel = await sock.newsletterMetadata('invite', SUPPORT_CHANNEL)
    if (channel?.id) {
      await sock.newsletterFollow(channel.id)
      console.log('[WA] Support channel followed')
    }
  } catch (error) {
    console.error('[WA] Support channel error:', error?.message || error)
  }

  try {
    await sock.groupAcceptInvite(SUPPORT_GROUP)
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
    console.log(`[WA] Active message sent to bot: ${botJid}`)
  } catch (error) {
    console.error('[WA] Active message error:', error?.message || error)
  }
}

async function connect() {
  if (reconnecting) return
  reconnecting = true

  try {
    ensureDirectories()

    const restored = await restoreRemoteSession(forceRestore)
    forceRestore = false

    if (restored !== 'ok') {
      reconnecting = false
      if (restored === 'invalid') {
        console.error('[SESSION] No valid session. Bot not started.')
        return
      }
      if (++sessionRetries > 5) {
        console.error('[SESSION] Giving up after repeated download failures.')
        return
      }
      console.log('[SESSION] Retrying in 60 seconds...')
      await sleep(60000)
      return connect()
    }

    sessionRetries = 0

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR)

    sock = makeWASocket({
      auth: state,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      markOnlineOnConnect: true,
      syncFullHistory: true,
      generateHighQualityLinkPreview: false
    })

    sock.ev.on('creds.update', saveCreds)

    /*
     * ─── NEW: run plugin setup hooks (anti-delete registers messages.update here) ───
     */
    for (const hook of setupHooks) {
      try {
        await hook(sock)
      } catch (e) {
        console.error(`[SETUP] Hook ${hook.name || '?'} failed:`, e?.message || e)
      }
    }

    sock.ev.on('messages.upsert', async event => {
      try {
        await handleMessages(event, sock, plugins, messageListeners)
      } catch (error) {
        console.error('[HANDLER] Message event error:', error?.stack || error?.message || error)
      }
    })

    sock.ev.on('group-participants.update', async event => {
      try {
        await handleGroupParticipants(event, sock, groupListeners)
      } catch (error) {
        console.error('[HANDLER] Group event error:', error?.stack || error?.message || error)
      }
    })

    sock.ev.on('connection.update', async update => {
      const { connection, lastDisconnect } = update

      if (connection === 'connecting') {
        console.log('[WA] Connecting to WhatsApp...')
      }

      if (connection === 'open') {
        console.log('')
        console.log('╭──────────────────────────────╮')
        console.log('│     𝐑ᴀᴢᴀ-𝐌ᴅ 𝐂ᴏɴɴᴇᴄᴛᴇᴅ     │')
        console.log('├──────────────────────────────┤')
        console.log('│  𝐌ᴜʟᴛɪ-𝐃ᴇᴠɪᴄᴇ 𝐖ʜᴀᴛsᴀᴘᴘ     │')
        console.log('│  𝐁ᴏᴛ 𝐈s 𝐑ᴜɴɴɪɴɢ             │')
        console.log('╰──────────────────────────────╯')
        console.log(`[WA] User: ${sock?.user?.id || 'unknown'}`)
        console.log(`[WA] Plugins: ${plugins.size}`)
        console.log(`[WA] Message listeners: ${messageListeners.length}`)
        console.log(`[WA] Group listeners: ${groupListeners.length}`)
        console.log(`[WA] Setup hooks: ${setupHooks.length}`)

        reconnecting = false
        badSessionRetries = 0
        replacedRetries = 0

        startSessionSync()

        setImmediate(async () => {
          try {
            await startAlwaysOnline(sock)
          } catch (error) {
            console.error('[WA] Presence error:', error?.message || error)
          }
        })

        setTimeout(async () => {
          try {
            await startSupport(sock)
          } catch (error) {
            console.error('[WA] Support startup error:', error?.message || error)
          }
        }, 1000)

        setTimeout(async () => {
          try {
            await sendActiveMessage()
          } catch (error) {
            console.error('[WA] Active message startup error:', error?.message || error)
          }
        }, 1500)

        return
      }

      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
        console.error(`[WA] Connection closed. Code: ${statusCode || 'unknown'}`)
        reconnecting = false

        if (statusCode === DisconnectReason.loggedOut) {
          console.error('[WA] Session logged out.')
          try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }) } catch {}
          console.error('[WA] Session directory removed. Generate a new session.')
          return
        }

        if (statusCode === DisconnectReason.badSession) {
          console.error('[WA] Bad session detected.')
          if (SESSION_ID && ++badSessionRetries <= 2) {
            console.error('[WA] Downloading a fresh copy from the server...')
            forceRestore = true
            await sleep(3000)
            return connect()
          }
          console.error('[WA] The stored session is invalid or corrupted. Generate a new session.')
          return
        }

        if (statusCode === DisconnectReason.connectionReplaced) {
          if (++replacedRetries > 3) {
            console.error('[WA] This session is in use by another instance. Stopped.')
            return
          }
          console.error('[WA] Connection replaced by another instance. Retrying in 30 seconds...')
          await sleep(30000)
          return connect()
        }

        console.log('[WA] Reconnecting in 5 seconds...')
        await sleep(statusCode === DisconnectReason.restartRequired ? 1000 : 5000)
        try { await connect() } catch (error) {
          console.error('[WA] Reconnect error:', error?.message || error)
        }
      }
    })
  } catch (error) {
    reconnecting = false
    console.error('[WA] Connection error:', error?.stack || error?.message || error)
    console.log('[WA] Retrying in 5 seconds...')
    await sleep(5000)
    try { await connect() } catch (retryError) {
      console.error('[WA] Retry error:', retryError?.message || retryError)
    }
  }
}

async function start() {
  console.log('')
  console.log('╭──────────────────────────────╮')
  console.log('│       ʀᴀᴢᴀ-ᴍᴅ ᴡʜᴀᴛsᴀᴘᴘ      │')
  console.log('│        ᴍᴜʟᴛɪ-ᴅᴇᴠɪᴄᴇ        │')
  console.log('╰──────────────────────────────╯')
  console.log('')
  console.log('[SYSTEM] Starting Raza-MD...')
  console.log(`[SYSTEM] Node: ${process.version}`)
  console.log(`[SYSTEM] Prefix: ${process.env.PREFIX || '.'}`)
  console.log(`[SYSTEM] Pair server: ${PAIR_SERVER_URL}`)

  try {
    await loadPlugins()
    console.log(`[PLUGIN] Loaded ${plugins.size} command(s).`)
    console.log(`[PLUGIN] Loaded ${messageListeners.length} message listener(s).`)
    console.log(`[PLUGIN] Loaded ${groupListeners.length} group listener(s).`)
    console.log(`[PLUGIN] Loaded ${setupHooks.length} setup hook(s).`)
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
  try { await Promise.race([pushSession(), sleep(8000)]) } catch {}
  try { sock?.end(new Error('Process terminated')) } catch {}
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

start()
