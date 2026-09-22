import { jidNormalizedUser } from '@whiskeysockets/baileys'
import { getDb, saveDb } from '../database/index.js'

const DB_KEY = 'antimod.json'

function normalizeJid(jid) {
  if (!jid) return ''
  try {
    return jidNormalizedUser(String(jid))
  } catch {
    return String(jid).split(':')[0]
  }
}

function numberFromJid(jid) {
  return normalizeJid(jid)
    .split('@')[0]
    .split(':')[0]
    .replace(/\D/g, '')
}

function isBot(sock, jid) {
  if (!jid || !sock?.user) return false
  const targetJid = normalizeJid(jid)
  const targetNum = numberFromJid(targetJid)
  const botJid = normalizeJid(sock.user.id || '')
  const botLid = normalizeJid(sock.user.lid || '')
  const botNum = numberFromJid(botJid || sock.user.id || '')

  if (targetJid && (targetJid === botJid || targetJid === botLid)) {
    return true
  }
  if (targetNum && botNum && targetNum === botNum) {
    return true
  }
  return false
}

// Clean Unicode Small Caps Mapping
function toSmallCaps(text) {
  const map = {
    a: '\u1D00', b: '\u0299', c: '\u1D04', d: '\u1D05', e: '\u1D07',
    f: '\u0493', g: '\u0262', h: '\u029C', i: '\u026A', j: '\u1D0A',
    k: '\u1D0B', l: '\u029F', m: '\u1D0D', n: '\u0274', o: '\u1D0F',
    p: '\u1D18', q: '\u01FA', r: '\u0280', s: 's',      t: '\u1D1B',
    u: '\u1D1C', v: '\u1D20', w: '\u1D21', x: 'x',      y: '\u028F',
    z: '\u1D22'
  }
  return String(text || '')
    .toLowerCase()
    .split('')
    .map((c) => map[c] || c)
    .join('')
}

/* =========================================================
   MANUAL EXEMPT USERS
   ========================================================= */
const MANUAL_EXEMPT = [
  '12262792369@s.whatsapp.net',
  '923280966780@s.whatsapp.net',
  '923197135780@s.whatsapp.net'
].map(normalizeJid)

function isExempt(sock, jid) {
  if (!jid) return true
  if (isBot(sock, jid)) {
    return true
  }
  return MANUAL_EXEMPT.includes(normalizeJid(jid))
}

/* =========================================================
   OWN ACTION LOCK
   ========================================================= */
const ownActions = new Map()

function actionKey(jid, action, users) {
  return [normalizeJid(jid), action, ...users.map(normalizeJid).sort()].join('|')
}

function rememberOwnAction(jid, action, users) {
  for (const user of users) {
    const key = actionKey(jid, action, [user])
    ownActions.set(key, Date.now())
    setTimeout(() => {
      ownActions.delete(key)
    }, 15000)
  }
}

function wasOwnAction(jid, action, users) {
  return users.some((user) => {
    const key = actionKey(jid, action, [user])
    const time = ownActions.get(key)
    if (!time) return false
    if (Date.now() - time > 15000) {
      ownActions.delete(key)
      return false
    }
    return true
  })
}

/* =========================================================
   COMMAND
   ========================================================= */
export const antimodCommand = {
  command: ['antimod'],
  async run({ sock, message, args, isGroup, isOwner }) {
    try {
      const jid = normalizeJid(message?.key?.remoteJid)
      if (!isGroup || !jid.endsWith('@g.us')) return

      const metadata = await sock.groupMetadata(jid).catch(() => null)
      if (!metadata) return

      const sender = normalizeJid(message?.key?.participant || message?.participant || '')
      const participant = metadata.participants.find((p) => normalizeJid(p.id) === sender)
      const isAdmin = Boolean(participant?.admin)

      if (!isAdmin && !isOwner) return

      const storage = getDb(DB_KEY, {})
      const action = String(args?.[0] || '').trim().toLowerCase()

      if (action === 'on') {
        storage[jid] = true
        saveDb(DB_KEY, storage)
        return sock.sendMessage(
          jid,
          { text: `✅ *${toSmallCaps('anti-modification activated.')}*` },
          { quoted: message }
        )
      }

      if (action === 'off') {
        delete storage[jid]
        saveDb(DB_KEY, storage)
        return sock.sendMessage(
          jid,
          { text: `❌ *${toSmallCaps('anti-modification deactivated.')}*` },
          { quoted: message }
        )
      }

      const status = storage[jid] ? 'ON' : 'OFF'
      return sock.sendMessage(
        jid,
        {
          text:
            `⚙️ *${toSmallCaps('anti-mod status')}:* ${status}\n\n` +
            `*${toSmallCaps('usage')}:* !antimod on/off`
        },
        { quoted: message }
      )
    } catch (error) {
      console.error('[ANTIMOD] Command error:', error)
    }
  }
}

/* =========================================================
   GROUP LISTENER
   ========================================================= */
export const antimodListener = {
  command: '__welcome_listener',
  async run({ sock, update }) {
    try {
      if (!update) return
      const jid = normalizeJid(update.id)
      if (!jid || !jid.endsWith('@g.us')) return

      const action = update.action
      if (action !== 'promote' && action !== 'demote') return

      const storage = getDb(DB_KEY, {})
      if (!storage[jid]) return

      const rawParticipants = Array.isArray(update.participants) ? update.participants : []
      const targets = rawParticipants
        .map((p) => {
          if (typeof p === 'string') return normalizeJid(p)
          return normalizeJid(p?.id || p?.jid || p?.participant || '')
        })
        .filter(Boolean)

      if (!targets.length) return

      // Ignore events created by AntiMod itself.
      if (wasOwnAction(jid, action, targets)) return

      // Find actor who performed the action.
      const actor = normalizeJid(update.author || update.actor || update.by || '')

      // Never process the bot as actor.
      if (actor && isBot(sock, actor)) return

      // Filter non-exempt targets.
      const unsafeTargets = targets.filter((target) => !isExempt(sock, target))

      /*
       * PROMOTE: Someone promotes a participant.
       * Target -> DEMOTE | Actor -> DEMOTE
       */
      if (action === 'promote') {
        const toDemote = [...unsafeTargets]
        if (
          actor &&
          !isExempt(sock, actor) &&
          !toDemote.some((x) => normalizeJid(x) === normalizeJid(actor))
        ) {
          toDemote.push(actor)
        }

        if (!toDemote.length) return

        rememberOwnAction(jid, 'demote', toDemote)

        for (const user of toDemote) {
          if (isExempt(sock, user)) continue
          await sock.groupParticipantsUpdate(jid, [user], 'demote').catch(() => {})
        }

        const mentions = toDemote.filter((user) => !isExempt(sock, user))
        let text = `⚠️ *${toSmallCaps('anti-promote triggered!')}*\n\n`
        if (actor && !isExempt(sock, actor)) {
          text += `*${toSmallCaps('actor')}:* @${numberFromJid(actor)}\n`
        }
        text += `*${toSmallCaps('action')}:* ${toSmallCaps('promoted participant and actor demoted.')}`

        await sock.sendMessage(jid, { text, mentions }).catch(() => {})
        return
      }

      /*
       * DEMOTE: Someone demotes a participant.
       * Target -> PROMOTE BACK | Actor -> DEMOTE
       */
      if (action === 'demote') {
        const botIsTarget = targets.some((target) => isBot(sock, target))
        const targetsToRestore = unsafeTargets.filter((target) => !isBot(sock, target))

        if (!botIsTarget && targetsToRestore.length) {
          rememberOwnAction(jid, 'promote', targetsToRestore)
          for (const user of targetsToRestore) {
            if (isExempt(sock, user)) continue
            await sock.groupParticipantsUpdate(jid, [user], 'promote').catch(() => {})
          }
        }

        if (actor && !isExempt(sock, actor)) {
          rememberOwnAction(jid, 'demote', [actor])
          await sock.groupParticipantsUpdate(jid, [actor], 'demote').catch(() => {})
        }

        const mentions = [
          ...(actor && !isExempt(sock, actor) ? [actor] : []),
          ...targetsToRestore
        ]
        let text = `⚠️ *${toSmallCaps('anti-demote triggered!')}*\n\n`
        if (actor && !isExempt(sock, actor)) {
          text += `*${toSmallCaps('actor')}:* @${numberFromJid(actor)}\n`
        }
        text += `*${toSmallCaps('action')}:* ${toSmallCaps('demoted participant restored and actor demoted.')}`

        await sock.sendMessage(jid, { text, mentions }).catch(() => {})
        return
      }
    } catch (error) {
      console.error('[ANTIMOD] Listener error:', error)
    }
  }
}

export default antimodCommand