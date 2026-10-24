import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  jidNormalizedUser
} from '@whiskeysockets/baileys'

import { Boom } from '@hapi/boom'
import pino from 'pino'

import crypto from 'crypto'
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

// Optional safety net: restart the process when memory passes this many MB (0 = off).
const MAX_MEMORY_MB = Number(process.env.MAX_MEMORY_MB) || 0

// A socket that has not reached "open" after this long is thrown away and rebuilt.
const OPEN_TIMEOUT_MS = 90 * 1000

// Set LOG_LEVEL=info (or debug) to see Baileys' own logs when hunting a problem.
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' })

const SUPPORT_CHANNEL = '0029VbDLmtj0VycIgtiOTO1i'
const SUPPORT_GROUP = 'J1tCnTpbhKYHQP7eAT5kiw'

let sock = null
let socketGen = 0 // bumped for every new socket; handlers of older sockets go quiet
let connecting = false
let halted = false // set when reconnecting would be pointless (logged out, bad session…)
let shuttingDown = false
let reconnectTimer = null
let openWatchdog = null
let reconnectAttempts = 0

let activeMessageSent = false
let supportDone = false
let syncStarted = false
let syncPromise = null
let syncOff = false
let lastSig = ''
let forceRestore = false
let sessionRetries = 0
let badSessionRetries = 0
let replacedRetries = 0

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms
    )
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function ensureDirectories() {
  fs.mkdirSync(SESSION_DIR, { recursive: true })
}

function validCredsBuffer(buffer) {
  try {
    return Boolean(JSON.parse(buffer.toString('utf8'))?.me?.id)
  } catch {
    return false
  }
}

function validCredsAt(file) {
  try {
    return validCredsBuffer(fs.readFileSync(file))
  } catch {
    return false
  }
}

/*
 * ==============================
 * SPEED CACHES
 * ==============================
 */

/*
 * Messages the bot sent. Baileys asks for these through getMessage() when
 * WhatsApp requests a retry; without it the receiver can be stuck on
 * "Waiting for this message".
 */
const sentCache = new Map()
const SENT_CACHE_MAX = 300

function rememberSent(msg) {
  const id = msg?.key?.id
  const content = msg?.message
  if (!id || !msg.key.fromMe || !content) return
  if (content.reactionMessage || content.protocolMessage) return

  sentCache.delete(id)
  sentCache.set(id, content)
  if (sentCache.size > SENT_CACHE_MAX) {
    sentCache.delete(sentCache.keys().next().value)
  }
}

async function getMessage(key) {
  return sentCache.get(key?.id)
}

/*
 * Group metadata. Without this, EVERY message sent to a group first asks
 * WhatsApp for the group's member list. One command = reaction + reaction
 * removal + reply = 3 extra round trips. Entries are dropped whenever the
 * group changes, so new members still get the message.
 */
const groupCache = new Map()
const GROUP_TTL_MS = 5 * 60 * 1000
const GROUP_CACHE_MAX = 300

function cacheGroup(jid, meta) {
  groupCache.delete(jid)
  groupCache.set(jid, { meta, exp: Date.now() + GROUP_TTL_MS })
  if (groupCache.size > GROUP_CACHE_MAX) {
    groupCache.delete(groupCache.keys().next().value)
  }
}

async function cachedGroupMetadata(jid) {
  if (!String(jid).endsWith('@g.us') || !sock) return undefined

  const hit = groupCache.get(jid)
  if (hit && hit.exp > Date.now()) return hit.meta

  try {
    const meta = await sock.groupMetadata(jid)
    cacheGroup(jid, meta)
    return meta
  } catch {
    groupCache.delete(jid)
    return undefined // Baileys falls back to its own lookup
  }
}

/*
 * ==============================
 * SESSION RESTORE / BACKUP
 * ==============================
 */

async function restoreRemoteSession(force = false) {
  if (!force && validCredsAt(CREDS_FILE)) {
    console.log('[SESSION] Using local session.')
    return 'ok'
  }

  if (!SESSION_ID) {
    console.error('[SESSION] SESSION_ID not found.')
    return 'invalid'
  }

  const MAX_ATTEMPTS = 6

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`[SESSION] Restoring remote session (attempt ${attempt})...`)

      const response = await fetch(SESSION_URL, {
        signal: AbortSignal.timeout(60000)
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
      console.error('[SESSION] Restore error:', error?.message || error)
      if (attempt < MAX_ATTEMPTS) await sleep(attempt * 3000)
    }
  }

  return 'retry'
}

/*
 * FIX: the old version read every session file with readFileSync (and
 * base64-encoded them all in one go) on the main thread every 10 minutes.
 * With a big session folder that freezes the bot for a moment, can drop the
 * WhatsApp connection, and spikes memory. Everything here is async now.
 */
async function listSessionFiles() {
  const names = (await fs.promises.readdir(SESSION_DIR)).sort()
  const list = []

  for (let i = 0; i < names.length; i += 50) {
    const batch = await Promise.all(
      names.slice(i, i + 50).map(async name => {
        try {
          const stat = await fs.promises.stat(path.join(SESSION_DIR, name))
          return stat.isFile() ? { name, size: stat.size, mtime: stat.mtimeMs } : null
        } catch {
          return null
        }
      })
    )
    for (const item of batch) if (item) list.push(item)
  }

  return list
}

async function doPushSession() {
  if (!SESSION_ID || syncOff || !validCredsAt(CREDS_FILE)) return

  const list = await listSessionFiles()
  if (!list.length) return

  const sig = crypto
    .createHash('md5')
    .update(list.map(f => `${f.name}:${f.size}:${f.mtime}`).join('|'))
    .digest('hex')
  if (sig === lastSig) return

  /*
   * FIX: never upload a half-written creds.json. If that ever reached the
   * server, the next restart could not restore the session at all.
   */
  const credsBuffer = await fs.promises.readFile(CREDS_FILE)
  if (!validCredsBuffer(credsBuffer)) {
    console.log('[SESSION] creds.json is being written, will sync next cycle.')
    return
  }

  const files = { 'creds.json': credsBuffer.toString('base64') }
  let bytes = credsBuffer.length
  const rest = list.filter(f => f.name !== 'creds.json')

  for (let i = 0; i < rest.length; i += 25) {
    await Promise.all(
      rest.slice(i, i + 25).map(async ({ name }) => {
        try {
          const buffer = await fs.promises.readFile(path.join(SESSION_DIR, name))
          files[name] = buffer.toString('base64')
          bytes += buffer.length
        } catch {
          // file disappeared between listing and reading, skip it
        }
      })
    )
  }

  const response = await fetch(SESSION_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files }),
    signal: AbortSignal.timeout(60000)
  })

  if (response.ok) {
    lastSig = sig
    console.log(
      `[SESSION] Synced to server (${Object.keys(files).length} files, ${(bytes / 1048576).toFixed(1)} MB).`
    )
  } else if (response.status === 404 || response.status === 405) {
    syncOff = true
    console.error('[SESSION] Server does not accept session updates. Sync disabled.')
  } else {
    const body = await response.text().catch(() => '')
    console.error(`[SESSION] Sync failed: HTTP ${response.status} — ${body.slice(0, 200)}`)
  }
}

function pushSession() {
  if (syncPromise) return syncPromise

  syncPromise = doPushSession()
    .catch(error => console.error('[SESSION] Sync error:', error?.message || error))
    .finally(() => {
      syncPromise = null
    })

  return syncPromise
}

function startSessionSync() {
  if (syncStarted || !SESSION_ID) return
  syncStarted = true
  setTimeout(pushSession, 60 * 1000).unref()
  setInterval(pushSession, SYNC_MINUTES * 60 * 1000).unref()
}

/*
 * ==============================
 * SUPPORT + ACTIVE MESSAGE
 * ==============================
 */

async function startSupport(s) {
  if (supportDone) return
  supportDone = true

  try {
    const channel = await s.newsletterMetadata('invite', SUPPORT_CHANNEL)
    if (channel?.id) {
      await s.newsletterFollow(channel.id)
      console.log('[WA] Support channel followed')
    }
  } catch (error) {
    console.error('[WA] Support channel error:', error?.message || error)
  }

  try {
    await s.groupAcceptInvite(SUPPORT_GROUP)
    console.log('[WA] Support group joined')
  } catch (error) {
    console.error('[WA] Support group error:', error?.message || error)
  }
}

async function sendActiveMessage(s) {
  if (activeMessageSent || !s?.user?.id) return

  try {
    const botJid = jidNormalizedUser(s.user.id)
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

    await s.sendMessage(botJid, { text: activeMessage })
    activeMessageSent = true
    console.log(`[WA] Active message sent to bot: ${botJid}`)
  } catch (error) {
    console.error('[WA] Active message error:', error?.message || error)
  }
}

/*
 * ==============================
 * CONNECTION LIFECYCLE
 * ==============================
 */

function disposeSocket(old) {
  if (!old) return
  try { old.end(undefined) } catch {}
  try { old.ev.removeAllListeners() } catch {}
}

function nextRetryDelay() {
  reconnectAttempts++
  return Math.min(5000 * 2 ** (reconnectAttempts - 1), 60000)
}

/*
 * One timer, one place. Replaces the old "reconnecting" flag, which could get
 * stuck on `true` and stop the bot from ever reconnecting.
 */
function scheduleReconnect(delayMs, reason) {
  if (shuttingDown || halted || reconnectTimer) return

  console.log(`[WA] ${reason} Reconnecting in ${Math.round(delayMs / 1000)}s...`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delayMs)
}

async function runSetupHooks(s) {
  await Promise.allSettled(
    setupHooks.map(async hook => {
      const label = hook.__file || hook.name || '?'
      try {
        await withTimeout(Promise.resolve(hook(s)), 15000, `setup hook ${label}`)
      } catch (error) {
        console.error(`[SETUP] Hook ${label} failed:`, error?.message || error)
      }
    })
  )
}

async function onConnectionUpdate(gen, s, update) {
  if (gen !== socketGen) return

  const { connection, lastDisconnect } = update

  if (connection === 'connecting') {
    console.log('[WA] Connecting to WhatsApp...')
    return
  }

  if (connection === 'open') {
    clearTimeout(openWatchdog)
    reconnectAttempts = 0
    badSessionRetries = 0
    replacedRetries = 0

    console.log('')
    console.log('╭──────────────────────────────╮')
    console.log('│     𝐑ᴀᴢᴀ-𝐌ᴅ 𝐂ᴏɴɴᴇᴄᴛᴇᴅ     │')
    console.log('├──────────────────────────────┤')
    console.log('│  𝐌ᴜʟᴛɪ-𝐃ᴇᴠɪᴄᴇ 𝐖ʜᴀᴛsᴀᴘᴘ     │')
    console.log('│  𝐁ᴏᴛ 𝐈s 𝐑ᴜɴɴɪɴɢ             │')
    console.log('╰──────────────────────────────╯')
    console.log(`[WA] User: ${s.user?.id || 'unknown'}`)
    console.log(`[WA] Plugins: ${plugins.size}`)
    console.log(`[WA] Message listeners: ${messageListeners.length}`)
    console.log(`[WA] Group listeners: ${groupListeners.length}`)
    console.log(`[WA] Setup hooks: ${setupHooks.length}`)

    startSessionSync()

    setImmediate(async () => {
      try {
        await startAlwaysOnline(s)
      } catch (error) {
        console.error('[WA] Presence error:', error?.message || error)
      }
    })

    setTimeout(async () => {
      try {
        await startSupport(s)
      } catch (error) {
        console.error('[WA] Support startup error:', error?.message || error)
      }
    }, 1000)

    setTimeout(async () => {
      try {
        await sendActiveMessage(s)
      } catch (error) {
        console.error('[WA] Active message startup error:', error?.message || error)
      }
    }, 1500)

    return
  }

  if (connection === 'close') {
    clearTimeout(openWatchdog)

    const error = lastDisconnect?.error
    const statusCode =
      error?.output?.statusCode ?? (error ? new Boom(error)?.output?.statusCode : undefined)
    console.error(`[WA] Connection closed. Code: ${statusCode || 'unknown'}`)

    if (statusCode === DisconnectReason.loggedOut) {
      halted = true
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
        scheduleReconnect(3000, 'Bad session.')
        return
      }
      halted = true
      console.error('[WA] The stored session is invalid or corrupted. Generate a new session.')
      return
    }

    /*
     * FIX: used to give up for good after 3 tries. A normal restart/deploy
     * briefly runs two copies of the bot, so give the old one time to go away.
     */
    if (statusCode === DisconnectReason.connectionReplaced) {
      if (++replacedRetries > 8) {
        halted = true
        console.error('[WA] This session is in use by another instance. Stopped.')
        return
      }
      scheduleReconnect(
        Math.min(30000 * replacedRetries, 300000),
        'Connection replaced by another instance.'
      )
      return
    }

    if (statusCode === DisconnectReason.restartRequired) {
      scheduleReconnect(1000, 'Restart required.')
      return
    }

    scheduleReconnect(nextRetryDelay(), 'Connection lost.')
  }
}

async function createSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR)

  const gen = ++socketGen
  disposeSocket(sock) // old socket must not keep running next to the new one

  const s = makeWASocket({
    auth: {
      creds: state.creds,
      // cached key store = far fewer disk reads while encrypting/decrypting
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    logger,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false, // presence is handled by startAlwaysOnline
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60_000,
    getMessage,
    cachedGroupMetadata
  })

  sock = s

  /*
   * FIX: register every event handler FIRST, synchronously. Before, the setup
   * hooks were awaited before these lines, so a slow/hung hook meant the
   * "close" event was never seen and the bot never reconnected.
   */
  s.ev.on('creds.update', saveCreds)

  s.ev.on('connection.update', update => {
    onConnectionUpdate(gen, s, update).catch(error => {
      console.error('[WA] Connection handler error:', error?.stack || error?.message || error)
    })
  })

  s.ev.on('messages.upsert', async event => {
    if (gen !== socketGen) return

    for (const message of event.messages || []) rememberSent(message)

    try {
      await handleMessages(event, s, plugins, messageListeners)
    } catch (error) {
      console.error('[HANDLER] Message event error:', error?.stack || error?.message || error)
    }
  })

  s.ev.on('group-participants.update', async event => {
    if (gen !== socketGen) return

    // drop the cached member list first so welcome/goodbye messages see the change
    if (event?.id) groupCache.delete(event.id)

    try {
      await handleGroupParticipants(event, s, groupListeners)
    } catch (error) {
      console.error('[HANDLER] Group event error:', error?.stack || error?.message || error)
    }
  })

  s.ev.on('groups.update', updates => {
    for (const update of updates || []) {
      if (update?.id) groupCache.delete(update.id)
    }
  })

  // Plugin setup hooks (anti-delete registers messages.update here). Not awaited.
  runSetupHooks(s).catch(() => {})

  // If the socket never reaches "open", rebuild it instead of hanging forever.
  clearTimeout(openWatchdog)
  openWatchdog = setTimeout(() => {
    if (gen !== socketGen) return
    console.error('[WA] Socket did not open in time. Rebuilding connection...')
    try { s.end(new Error('Open timeout')) } catch {}
  }, OPEN_TIMEOUT_MS)
}

async function connect() {
  if (connecting || shuttingDown || halted) return
  connecting = true

  try {
    ensureDirectories()

    const restored = await restoreRemoteSession(forceRestore)
    forceRestore = false

    if (restored === 'invalid') {
      halted = true
      console.error('[SESSION] No valid session. Bot not started.')
      return
    }

    if (restored !== 'ok') {
      // FIX: used to give up after 5 tries. A pair server that is asleep or
      // down for a few minutes must not kill the bot permanently.
      scheduleReconnect(Math.min(60000 * ++sessionRetries, 300000), 'Session download failed.')
      return
    }

    sessionRetries = 0
    await createSocket()
  } catch (error) {
    console.error('[WA] Connection error:', error?.stack || error?.message || error)
    scheduleReconnect(nextRetryDelay(), 'Connection setup failed.')
  } finally {
    connecting = false
  }
}

/*
 * ==============================
 * START / SHUTDOWN
 * ==============================
 */

function startMemoryWatch() {
  setInterval(() => {
    const mem = process.memoryUsage()
    const rss = Math.round(mem.rss / 1048576)
    console.log(`[MEM] rss=${rss}MB heap=${Math.round(mem.heapUsed / 1048576)}MB`)

    if (MAX_MEMORY_MB && rss > MAX_MEMORY_MB) {
      console.error(`[MEM] ${rss}MB is above MAX_MEMORY_MB (${MAX_MEMORY_MB}MB). Restarting...`)
      shutdown('MEMORY_LIMIT', 1)
    }
  }, 10 * 60 * 1000).unref()
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

  startMemoryWatch()
  await connect()
}

process.on('uncaughtException', error => {
  console.error('[PROCESS] Uncaught exception:', error?.stack || error?.message || error)
})

process.on('unhandledRejection', error => {
  console.error('[PROCESS] Unhandled rejection:', error?.stack || error?.message || error)
})

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true

  console.log(`[PROCESS] ${signal} received.`)
  clearTimeout(reconnectTimer)
  clearTimeout(openWatchdog)

  try {
    await Promise.race([
      (async () => {
        if (syncPromise) await syncPromise // let an upload in progress finish
        await pushSession()
      })(),
      sleep(8000)
    ])
  } catch {}

  try { sock?.end(new Error('Process terminated')) } catch {}
  process.exit(exitCode)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

start()
