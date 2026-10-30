import { jidNormalizedUser } from '@whiskeysockets/baileys'

import {
  getDb,
  saveDb
} from './database/index.js'

const OWNER_NUMBER =
  (process.env.OWNER_NUMBER || '').replace(/\D/g, '')

const PERMANENT_OWNERS = [
  '923493149939',
  '923197135780',
  '923483151716',
  '923199279334'
]

/*
 * Messages that arrive while the bot was offline are delivered as type
 * "append" when it reconnects. Commands in that backlog older than this many
 * seconds are skipped, so a restart does not replay old commands.
 */
const MAX_BACKLOG_COMMAND_AGE = Number(process.env.MAX_COMMAND_AGE_SEC) || 120

let alwaysOnlineTimer = null

function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/*
 * ==============================
 * PREFIX
 * ==============================
 */

export function getPrefix() {
  return process.env.PREFIX || '.'
}

/*
 * ==============================
 * JID HELPERS
 * ==============================
 */

export function normalizeJid(jid) {
  if (!jid) return ''
  try {
    return jidNormalizedUser(jid)
  } catch {
    return String(jid).split(':')[0]
  }
}

export function getSender(message) {
  const key = message?.key || {}
  return (
    key.participantPn ||
    key.senderPn ||
    key.participantAlt ||
    key.remoteJidAlt ||
    key.participant ||
    key.remoteJid ||
    ''
  )
}

export function senderNumber(jid) {
  return String(jid)
    .split('@')[0]
    .split(':')[0]
    .replace(/\D/g, '')
}

function getSenderNumbers(message) {
  const key = message?.key || {}
  const jids = [
    key.participantPn,
    key.senderPn,
    key.participantAlt,
    key.remoteJidAlt,
    key.participant,
    key.remoteJid
  ]
  return [
    ...new Set(
      jids
        .filter(Boolean)
        .map(senderNumber)
        .filter(Boolean)
    )
  ]
}

export function isGroup(jid) {
  return String(jid).endsWith('@g.us')
}

/*
 * ==============================
 * OWNER — synchronous, no DB round-trip
 * ==============================
 *
 * sudo.json is read async and cached; checkIsOwner stays synchronous by
 * reading the cache. The cache is refreshed every 15 s, and the refresh
 * functions are exported so a command that edits sudo/settings can call
 * them to apply the change instantly.
 */

let sudoCache = new Set()
let refreshingSudo = false

export async function refreshSudoCache() {
  if (refreshingSudo) return
  refreshingSudo = true

  try {
    const data = await withTimeout(getDb('sudo.json', { sudoNumbers: [] }), 10000)
    const list = Array.isArray(data?.sudoNumbers) ? data.sudoNumbers : []
    sudoCache = new Set(
      list
        .map(n => String(n).replace(/\D/g, ''))
        .filter(Boolean)
    )
  } catch (e) {
    console.error('[OWNER] sudo.json load failed:', e?.message || e)
  } finally {
    refreshingSudo = false
  }
}

refreshSudoCache()
setInterval(refreshSudoCache, 15_000).unref()

function getSudoNumbers() {
  return sudoCache
}

// numbers found by looking up a @lid sender (see resolveLidOwner)
const lidResolved = new WeakMap()

function numbersAreOwner(numbers, sock) {
  if (numbers.some(n => PERMANENT_OWNERS.includes(n))) return true

  const botNum = senderNumber(sock?.user?.id || '')
  const botLid = senderNumber(sock?.user?.lid || '')
  if (numbers.some(n => n && (n === botNum || n === botLid))) return true

  if (OWNER_NUMBER && numbers.includes(OWNER_NUMBER)) return true

  const sudos = getSudoNumbers()
  if (numbers.some(n => sudos.has(n))) return true

  return false
}

export function checkIsOwner(message, sock) {
  if (message?.key?.fromMe) return true

  const numbers = [
    ...getSenderNumbers(message),
    ...(lidResolved.get(message) || [])
  ]

  return numbersAreOwner(numbers, sock)
}

/*
 * Some senders (mainly in groups) only show up as an anonymous @lid id with
 * no phone number attached. Ask Baileys' LID map for the real number, but only
 * for command messages from people who did not already pass the owner check.
 */
async function resolveLidOwner(message, sock) {
  try {
    const lidMap = sock?.signalRepository?.lidMapping
    if (typeof lidMap?.getPNForLID !== 'function') return false

    const key = message?.key || {}
    const lids = [key.participant, key.remoteJid].filter(
      jid => typeof jid === 'string' && jid.endsWith('@lid')
    )
    if (!lids.length) return false

    const found = []
    for (const lid of lids) {
      const pn = await lidMap.getPNForLID(lid)
      const number = pn ? senderNumber(pn) : ''
      if (number) found.push(number)
    }
    if (!found.length) return false

    lidResolved.set(message, found)
    return checkIsOwner(message, sock)
  } catch {
    return false
  }
}

/*
 * ==============================
 * MESSAGE HELPERS
 * ==============================
 */

export function unwrapMessage(message) {
  let m = message?.message
  if (!m) return null
  for (let i = 0; i < 10; i++) {
    const next =
      m?.ephemeralMessage?.message ||
      m?.viewOnceMessage?.message ||
      m?.viewOnceMessageV2?.message ||
      m?.viewOnceMessageV2Extension?.message ||
      m?.documentWithCaptionMessage?.message
    if (!next) break
    m = next
  }
  return m
}

/*
 * Deep view-once detection — unwraps ephemeralMessage / groupStatusMessageV2
 * first, then checks for a VV wrapper. This is what autoread needs to
 * consult before invalidating the media key.
 */
function isViewOnceDeep(message) {
  let m = message?.message
  if (!m) return false
  for (let i = 0; i < 5; i++) {
    if (
      m.viewOnceMessage ||
      m.viewOnceMessageV2 ||
      m.viewOnceMessageV2Extension
    ) {
      return true
    }
    m =
      m.ephemeralMessage?.message ||
      m.groupStatusMessageV2?.message ||
      m.groupStatusMessage?.message
    if (!m) return false
  }
  return false
}

export function getText(message) {
  const m = unwrapMessage(message)
  if (!m) return ''
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ''
  ).trim()
}

export function getQuotedMessage(message) {
  const m = unwrapMessage(message)
  if (!m) return null
  const context =
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.audioMessage?.contextInfo ||
    m.documentMessage?.contextInfo ||
    m.stickerMessage?.contextInfo
  return context?.quotedMessage || null
}

// messageTimestamp can be a number, a numeric string or a protobuf Long
function tsSeconds(ts) {
  if (!ts) return 0
  if (typeof ts === 'number') return ts
  if (typeof ts === 'string') return Number(ts) || 0
  if (typeof ts.toNumber === 'function') return ts.toNumber()
  return Number(ts.low) || 0
}

/*
 * ==============================
 * SETTINGS
 * ==============================
 *
 * getDb is async. Settings are cached (refreshed every 15 s) so synchronous
 * reads are correct AND we don't hit the database on every single message.
 */

let settingsCache = { autoread: false, alwaysonline: false }
let refreshingSettings = false

export async function refreshSettingsCache() {
  if (refreshingSettings) return
  refreshingSettings = true

  try {
    const data = await withTimeout(
      getDb('settings.json', { autoread: false, alwaysonline: false }),
      10000
    )
    settingsCache = {
      autoread: data?.autoread === true,
      alwaysonline: data?.alwaysonline === true
    }
  } catch (e) {
    console.error('[SETTINGS] settings.json load failed:', e?.message || e)
  } finally {
    refreshingSettings = false
  }
}

refreshSettingsCache()
setInterval(refreshSettingsCache, 15_000).unref()

export function getAutoRead() {
  return settingsCache.autoread === true
}

export function getAlwaysOnline() {
  return settingsCache.alwaysonline === true
}

export async function setAutoRead(value) {
  const data = await getDb('settings.json', {
    autoread: false,
    alwaysonline: false
  })
  data.autoread = value === true
  await saveDb('settings.json', data)
  settingsCache = {
    ...settingsCache,
    autoread: data.autoread
  }
  return data
}

export async function setAlwaysOnline(value) {
  const data = await getDb('settings.json', {
    autoread: false,
    alwaysonline: false
  })
  data.alwaysonline = value === true
  await saveDb('settings.json', data)
  settingsCache = {
    ...settingsCache,
    alwaysonline: data.alwaysonline
  }
  return data
}

/*
 * ==============================
 * ALWAYS ONLINE
 * ==============================
 */

export async function startAlwaysOnline(sock) {
  if (!sock) return
  if (alwaysOnlineTimer) {
    clearInterval(alwaysOnlineTimer)
    alwaysOnlineTimer = null
  }
  if (!getAlwaysOnline()) {
    try { await sock.sendPresenceUpdate('unavailable') } catch {}
    return
  }
  try { await sock.sendPresenceUpdate('available') } catch {}
  alwaysOnlineTimer = setInterval(async () => {
    if (!getAlwaysOnline()) {
      await stopAlwaysOnline(sock)
      return
    }
    try { await sock.sendPresenceUpdate('available') } catch {}
  }, 20000)
  if (typeof alwaysOnlineTimer?.unref === 'function') {
    alwaysOnlineTimer.unref()
  }
}

export async function stopAlwaysOnline(sock) {
  if (alwaysOnlineTimer) {
    clearInterval(alwaysOnlineTimer)
    alwaysOnlineTimer = null
  }
  if (!sock) return
  try { await sock.sendPresenceUpdate('unavailable') } catch {}
}

/*
 * ==============================
 * MESSAGE LISTENER RUNNER
 * ==============================
 */

function runMessageListeners(messageListeners, data) {
  if (!Array.isArray(messageListeners) || !messageListeners.length) return
  Promise.allSettled(
    messageListeners.map(async listener => {
      try {
        if (typeof listener.on === 'function') {
          await listener.on(data)
        } else if (typeof listener.run === 'function') {
          await listener.run(data)
        }
      } catch (error) {
        console.error(
          '[Listener Error]:',
          error?.stack || error?.message || error
        )
      }
    })
  ).catch(error => {
    console.error(
      '[Listener Runner Error]:',
      error?.stack || error?.message || error
    )
  })
}

/*
 * ==============================
 * MESSAGE HANDLER
 * ==============================
 */

// fire-and-forget reaction; never throws and is never awaited by the command path
async function react(sock, jid, key, emoji) {
  try {
    await sock.sendMessage(jid, { react: { text: emoji, key } })
  } catch {}
}

// WhatsApp can deliver the same message twice (retries, reconnect replays)
const handledCommands = new Set()
const HANDLED_MAX = 500

function alreadyHandled(message) {
  const id = message?.key?.id
  if (!id) return false

  const k = `${message.key.remoteJid}:${id}`
  if (handledCommands.has(k)) return true

  handledCommands.add(k)
  if (handledCommands.size > HANDLED_MAX) {
    handledCommands.delete(handledCommands.values().next().value)
  }
  return false
}

async function processMessage(message, type, sock, plugins, messageListeners) {
  try {
    if (!message?.message) return

    const rawJid = message.key?.remoteJid || ''
    const isGroupStatusPost = !!message.message?.groupStatusMessageV2
    const isStatus = rawJid === 'status@broadcast'
    const normalizedRemoteJid = normalizeJid(rawJid)
    const text = getText(message)
    const isGroupChat = isGroup(normalizedRemoteJid) || isGroupStatusPost
    const activePrefix = getPrefix()
    let isOwner = checkIsOwner(message, sock)

    /*
     * Run listeners BEFORE any filtering so statusview / antivv /
     * antidelete see every incoming message.
     */
    runMessageListeners(messageListeners, {
      sock,
      message,
      text,
      isOwner,
      isGroup: isGroupChat,
      isStatus
    })

    if (isStatus || isGroupStatusPost) return

    if (!text || !text.startsWith(activePrefix)) return

    const body = text.slice(activePrefix.length).trim()
    if (!body) return

    const parts = body.split(/\s+/)
    const command = parts.shift().toLowerCase()
    const args = parts

    const plugin = plugins.get(command)
    if (!plugin) return

    const sentAt = tsSeconds(message.messageTimestamp)
    const age = sentAt ? Math.round(Date.now() / 1000 - sentAt) : 0

    if (type === 'append' && age > MAX_BACKLOG_COMMAND_AGE) {
      console.log(`⏭️ Skipped old command ${activePrefix}${command} (${age}s old)`)
      return
    }

    if (!isOwner) isOwner = await resolveLidOwner(message, sock)
    if (!isOwner) return

    if (alreadyHandled(message)) return

    const quotedMessage = getQuotedMessage(message)
    const startedAt = Date.now()

    console.log(
      `⚡ Executing: ${activePrefix}${command} from ${senderNumber(getSender(message))}` +
      (age > 5 ? ` (message arrived ${age}s late)` : '')
    )

    /*
     * FIX: the ⏳ reaction used to be awaited before the command started
     * (a full network round trip, plus a group lookup in groups). It now
     * goes out in parallel with the command.
     */
    let failed = false
    react(sock, rawJid, message.key, '⏳')
    setTimeout(() => {
      if (!failed) react(sock, rawJid, message.key, '')
    }, 1000)

    try {
      await plugin.run({
        sock,
        message,
        quotedMessage,
        args,
        text: args.join(' '),
        command,
        prefix: activePrefix,
        isOwner,
        isGroup: isGroupChat,
        plugins
      })
      console.log(`✅ ${activePrefix}${command} done in ${Date.now() - startedAt}ms`)
    } catch (error) {
      failed = true
      console.error(
        `❌ ${activePrefix}${command} failed:`,
        error?.stack || error?.message || error
      )
      react(sock, rawJid, message.key, '❌')
    }
  } catch (error) {
    console.error(
      'Message handling error:',
      error?.stack || error?.message || error
    )
  }
}

export async function handleMessages(update, sock, plugins, messageListeners) {
  if (update.type !== 'notify' && update.type !== 'append') return

  if (getAlwaysOnline() && !alwaysOnlineTimer) {
    startAlwaysOnline(sock).catch(error => {
      console.error('[Always Online Error]:', error?.message || error)
    })
  }

  const messages = update.messages || []

  /*
   * Autoread: one batched read receipt per upsert instead of one per message.
   * View-once messages are skipped so the antivv listener can still download
   * the media before its key is invalidated.
   */
  if (getAutoRead()) {
    const keys = messages
      .filter(m => m?.message && m.key?.id && !m.key.fromMe && !isViewOnceDeep(m))
      .map(m => m.key)

    if (keys.length) {
      Promise.resolve(sock.readMessages(keys)).catch(() => {})
    }
  }

  /*
   * FIX: messages (and their commands) are handled in parallel. Before, one
   * slow command made every message behind it in the same batch wait.
   */
  await Promise.allSettled(
    messages.map(message =>
      processMessage(message, update.type, sock, plugins, messageListeners)
    )
  )
}

/*
 * ==============================
 * GROUP PARTICIPANTS
 * ==============================
 */

export async function handleGroupParticipants(update, sock, groupListeners) {
  if (!update || !Array.isArray(groupListeners) || !groupListeners.length) return

  await Promise.allSettled(
    groupListeners.map(async listener => {
      try {
        await listener.run({ sock, update })
      } catch (error) {
        console.error(
          '[Group Listener Error]:',
          error?.stack || error?.message || error
        )
      }
    })
  )
}
