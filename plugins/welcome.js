
import { getDb, saveDb } from '../database/index.js'

const DB_KEY = 'welcome.json'
const DEDUPE_KEY = '__razaWelcomeDedup'
const DEDUPE_WINDOW = 60_000

function toSmallCaps(text) {
  const smallCapsMap = {
    a: '\u1D00', b: '\u0299', c: '\u1D04', d: '\u1D05',
    e: '\u1D07', f: '\u0493', g: '\u0262', h: '\u029C',
    i: '\u026A', j: '\u1D0A', k: '\u1D0B', l: '\u029F',
    m: '\u1D0D', n: '\u0274', o: '\u1D0F', p: '\u1D18',
    q: '\u01FA', r: '\u0280', s: 's', t: '\u1D1B',
    u: '\u1D1C', v: '\u1D20', w: '\u1D21', x: 'x',
    y: '\u028F', z: '\u1D22'
  }

  return String(text || '')
    .toLowerCase()
    .split('')
    .map(char => smallCapsMap[char] || char)
    .join('')
}

function defaultWelcomeText() {
  return (
    `👋 *${toSmallCaps('welcome to')}* &group\n\n` +
    `📌 &mention\n\n` +
    `_${toSmallCaps('powered by raza bot')}_`
  )
}

function normalizeJid(jid) {
  return String(jid || '').trim()
}

function normalizeGroupJid(jid) {
  return normalizeJid(jid).split(':')[0]
}

function getSettings(jid) {
  const storage = getDb(DB_KEY, {})

  if (!storage[jid]) {
    storage[jid] = {
      enabled: false,
      text: defaultWelcomeText()
    }

    saveDb(DB_KEY, storage)
  }

  return storage[jid]
}

function getDedupeMap() {
  if (!(globalThis[DEDUPE_KEY] instanceof Map)) {
    globalThis[DEDUPE_KEY] = new Map()
  }

  return globalThis[DEDUPE_KEY]
}

function cleanDedupeMap(map, now = Date.now()) {
  for (const [key, timestamp] of map) {
    if (now - timestamp >= DEDUPE_WINDOW) {
      map.delete(key)
    }
  }
}

function getParticipantId(item) {
  if (typeof item === 'string') return item

  if (!item || typeof item !== 'object') return ''

  return (
    item.id ||
    item.jid ||
    item.phoneNumber ||
    item.participantPn ||
    item.lid ||
    ''
  )
}

/*
 * ==============================
 * WELCOME COMMAND
 * ==============================
 */

export const welcomeCommand = {
  command: ['welcome', 'setwelcome'],
  category: 'group',
  description: 'Manage group welcome messages',

  async run({ sock, message, args, isGroup, isOwner }) {
    const jid = message?.key?.remoteJid

    if (!jid || !isGroup) return

    const metadata = await sock
      .groupMetadata(jid)
      .catch(() => null)

    if (!metadata) return

    const sender = normalizeJid(
      message?.key?.participant ||
      message?.key?.participantPn ||
      ''
    ).split(':')[0]

    const isAdmin = (metadata.participants || []).some(participant => {
      const participantId = normalizeJid(
        participant.id || participant.jid || ''
      ).split(':')[0]

      return (
        participantId === sender &&
        (
          participant.admin === 'admin' ||
          participant.admin === 'superadmin'
        )
      )
    })

    if (!isAdmin && !isOwner) return

    const cmd = String(args?.[0] || '').toLowerCase()
    const storage = getDb(DB_KEY, {})
    const settings = getSettings(jid)

    if (cmd === 'on') {
      settings.enabled = true
      storage[jid] = settings
      saveDb(DB_KEY, storage)

      return sock.sendMessage(
        jid,
        { text: `✅ ${toSmallCaps('welcome message enabled')}` },
        { quoted: message }
      )
    }

    if (cmd === 'off') {
      settings.enabled = false
      storage[jid] = settings
      saveDb(DB_KEY, storage)

      return sock.sendMessage(
        jid,
        { text: `❌ ${toSmallCaps('welcome message disabled')}` },
        { quoted: message }
      )
    }

    if (cmd === 'set') {
      const customMsg = args.slice(1).join(' ').trim()

      if (!customMsg) {
        return sock.sendMessage(
          jid,
          {
            text:
              `⚠️ ${toSmallCaps('please provide a text message.')}\n\n` +
              `*${toSmallCaps('example')}:*\n` +
              `${getPrefixForExample()}welcome set Welcome &mention to &group!`
          },
          { quoted: message }
        )
      }

      settings.text = customMsg
      settings.enabled = true
      storage[jid] = settings
      saveDb(DB_KEY, storage)

      return sock.sendMessage(
        jid,
        { text: `✅ ${toSmallCaps('welcome message updated successfully!')}` },
        { quoted: message }
      )
    }

    if (cmd === 'get') {
      return sock.sendMessage(
        jid,
        {
          text:
            `📌 *${toSmallCaps('current welcome message')}:*\n\n` +
            settings.text
        },
        { quoted: message }
      )
    }

    if (cmd === 'reset') {
      settings.text = defaultWelcomeText()
      storage[jid] = settings
      saveDb(DB_KEY, storage)

      return sock.sendMessage(
        jid,
        {
          text: `✅ ${toSmallCaps('welcome message reset to default.')}`
        },
        { quoted: message }
      )
    }

    const status = settings.enabled ? 'ON' : 'OFF'

    const menu =
      `⚙️ *${toSmallCaps('welcome settings')}*\n\n` +
      `• *${toSmallCaps('status')}:* ${status}\n\n` +
      `*${toSmallCaps('commands')}:*\n` +
      `├ \`${getPrefixForExample()}welcome on\` - Enable welcome\n` +
      `├ \`${getPrefixForExample()}welcome off\` - Disable welcome\n` +
      `├ \`${getPrefixForExample()}welcome set <text>\` - Set custom welcome text\n` +
      `├ \`${getPrefixForExample()}welcome get\` - View current text\n` +
      `└ \`${getPrefixForExample()}welcome reset\` - Reset text\n\n` +
      `*${toSmallCaps('placeholders')}:*\n` +
      `• \`&mention\` - Tags new member\n` +
      `• \`&group\` - Group name`

    return sock.sendMessage(
      jid,
      { text: menu },
      { quoted: message }
    )
  }
}

function getPrefixForExample() {
  return process.env.PREFIX || '.'
}

/*
 * ==============================
 * WELCOME EVENT LISTENER
 * ==============================
 */

export const welcomeListener = {
  command: '__welcome_listener',

  async run({ sock, update }) {
    if (!sock || !update) return

    const rawGroupJid = normalizeJid(update.id)
    const groupJid = normalizeGroupJid(rawGroupJid)
    const { participants, action } = update

    if (
      !groupJid.endsWith('@g.us') ||
      action !== 'add' ||
      !Array.isArray(participants) ||
      participants.length === 0
    ) {
      return
    }

    const storage = getDb(DB_KEY, {})
    const settings =
      storage[rawGroupJid] ||
      storage[groupJid]

    if (!settings?.enabled) return

    const now = Date.now()
    const processed = getDedupeMap()

    cleanDedupeMap(processed, now)

    /*
     * Claim each participant synchronously before the first await.
     * This prevents overlapping duplicate events from sending twice.
     */
    const claimed = []

    for (const participant of participants) {
      const participantJid = getParticipantId(participant)
      if (!participantJid) continue

      const dedupeId = normalizeJid(participantJid)
      const dedupeKey = `${groupJid}:${dedupeId}`
      const previous = processed.get(dedupeKey)

      if (
        previous !== undefined &&
        now - previous < DEDUPE_WINDOW
      ) {
        continue
      }

      processed.set(dedupeKey, now)

      claimed.push({
        participantJid,
        dedupeId,
        dedupeKey
      })
    }

    if (!claimed.length) return

    try {
      const metadata = await sock
        .groupMetadata(rawGroupJid)
        .catch(() => null)

      const groupName = metadata?.subject || 'Group'
      const canonicalByAlias = new Map()

      /*
       * Match alternate participant identifiers when Baileys
       * exposes them in the group participant metadata.
       */
      for (const participant of metadata?.participants || []) {
        const ids = [
          participant.id,
          participant.jid,
          participant.phoneNumber,
          participant.lid,
          participant.participantPn
        ]
          .filter(Boolean)
          .map(normalizeJid)

        const phoneJid = ids.find(id =>
          id.endsWith('@s.whatsapp.net')
        )

        const canonical = phoneJid || ids[0]
        if (!canonical) continue

        for (const id of ids) {
          canonicalByAlias.set(id, canonical)
        }
      }

      const latestStorage = getDb(DB_KEY, {})
      const latestSettings =
        latestStorage[rawGroupJid] ||
        latestStorage[groupJid]

      if (!latestSettings?.enabled) {
        for (const user of claimed) {
          processed.delete(user.dedupeKey)
        }
        return
      }

      const queued = new Map()

      for (const user of claimed) {
        const canonical =
          canonicalByAlias.get(user.participantJid) ||
          canonicalByAlias.get(user.dedupeId) ||
          user.dedupeId

        const canonicalKey = `${groupJid}:${canonical}`
        const canonicalTime = processed.get(canonicalKey)

        /*
         * If this event used an alternate JID but another event
         * already claimed its canonical identity, don't send again.
         */
        if (
          canonicalKey !== user.dedupeKey &&
          canonicalTime !== undefined &&
          now - canonicalTime < DEDUPE_WINDOW
        ) {
          processed.delete(user.dedupeKey)
          continue
        }

        processed.set(canonicalKey, now)

        const mentionJid =
          user.participantJid.endsWith('@s.whatsapp.net')
            ? user.participantJid
            : canonical

        if (!queued.has(canonicalKey)) {
          queued.set(canonicalKey, {
            canonicalKey,
            mentionJid
          })
        }
      }

      for (const user of queued.values()) {
        try {
          const currentStorage = getDb(DB_KEY, {})
          const currentSettings =
            currentStorage[rawGroupJid] ||
            currentStorage[groupJid]

          if (!currentSettings?.enabled) {
            processed.delete(user.canonicalKey)
            continue
          }

          const template = String(
            currentSettings.text || defaultWelcomeText()
          )

          const text = template
            .replace(
              /&mention/g,
              `@${user.mentionJid.split('@')[0]}`
            )
            .replace(/&group/g, groupName)

          await sock.sendMessage(groupJid, {
            text,
            mentions: [user.mentionJid]
          })
        } catch (error) {
          processed.delete(user.canonicalKey)

          console.error(
            '[Welcome Send Error]',
            error?.stack || error?.message || error
          )
        }
      }
    } catch (error) {
      for (const user of claimed) {
        processed.delete(user.dedupeKey)
      }

      console.error(
        '[Welcome Listener Error]',
        error?.stack || error?.message || error
      )
    }
  }
}

export default welcomeCommand
