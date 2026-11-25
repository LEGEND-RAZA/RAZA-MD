import { jidNormalizedUser } from '@whiskeysockets/baileys'
import { getDb, saveDb } from '../database/index.js'

const DB_KEY = 'gcprotect.json'

function toSmallCaps(text) {
  const map = {
    a: '\u1D00', b: '\u0299', c: '\u1D04', d: '\u1D05', e: '\u1D07',
    f: '\u0493', g: '\u0262', h: '\u029C', i: '\u026A', j: '\u1D0A',
    k: '\u1D0B', l: '\u029F', m: '\u1D0D', n: '\u0274', o: '\u1D0F',
    p: '\u1D18', q: '\u01FA', r: '\u0280', s: 's', t: '\u1D1B',
    u: '\u1D1C', v: '\u1D20', w: '\u1D21', x: 'x', y: '\u028F',
    z: '\u1D22'
  }
  return String(text || '').toLowerCase().split('').map(c => map[c] || c).join('')
}

function normalizeJid(jid) {
  if (!jid) return ''
  try {
    return jidNormalizedUser(String(jid))
  } catch {
    return String(jid).split(':')[0]
  }
}

/* =========================================================
   COMMAND
   ========================================================= */
export const gcprotectCommand = {
  command: ['gcprotect'],
  category: 'group',
  description: 'Protect group name and description from admin changes',

  async run({ sock, message, args, isGroup, isOwner }) {
    const jid = message?.key?.remoteJid
    if (!jid || !isGroup) return

    const metadata = await sock.groupMetadata(jid).catch(() => null)
    if (!metadata) return

    const sender = normalizeJid(message?.key?.participant || '')
    const isAdmin = metadata.participants.some(p => 
      (normalizeJid(p.id) === sender || normalizeJid(p.phoneNumber) === sender) && p.admin
    )

    if (!isAdmin && !isOwner) return

    const action = String(args[0] || '').toLowerCase()
    const storage = await getDb(DB_KEY, {})

    if (action === 'on') {
      storage[jid] = {
        enabled: true,
        name: metadata.subject || '',
        desc: metadata.desc || ''
      }
      await saveDb(DB_KEY, storage)

      return sock.sendMessage(jid, { 
        text: `✅ *${toSmallCaps('group protection enabled')}*\n\nᴄᴀᴄʜᴇᴅ ᴄᴜʀʀᴇɴᴛ ɴᴀᴍᴇ ᴀɴᴅ ᴅᴇsᴄ.` 
      }, { quoted: message })
    }

    if (action === 'off') {
      delete storage[jid]
      await saveDb(DB_KEY, storage)
      return sock.sendMessage(jid, { 
        text: `❌ *${toSmallCaps('group protection disabled')}*` 
      }, { quoted: message })
    }

    const status = storage[jid]?.enabled ? 'ᴏɴ' : 'ᴏғғ'
    return sock.sendMessage(jid, { 
      text: `⚙️ *${toSmallCaps('group protection')}:* ${status}\n\n*${toSmallCaps('usage')}:* .gcprotect on/off` 
    }, { quoted: message })
  }
}

/* =========================================================
   LISTENER (Name & Description)
   ========================================================= */
export const gcprotectListener = {
  setup(sock) {
    sock.ev.on('groups.update', async (updates) => {
      for (const update of updates) {
        const jid = update.id
        if (!jid.endsWith('@g.us')) continue

        const storage = await getDb(DB_KEY, {})
        const settings = storage[jid]
        if (!settings?.enabled) continue

        const botJid = normalizeJid(sock.user.id)
        const author = normalizeJid(update.author || '')

        // If bot changed it, ignore
        if (author && author === botJid) continue

        let changed = false

        // Check Name
        if (update.subject && update.subject !== settings.name) {
          console.log(`[GCPROTECT] Name changed in ${jid}. Reverting...`)
          await sock.groupUpdateSubject(jid, settings.name).catch(() => {})
          changed = true
        }

        // Check Description
        if (update.desc && update.desc !== settings.desc) {
          console.log(`[GCPROTECT] Desc changed in ${jid}. Reverting...`)
          await sock.groupUpdateDescription(jid, settings.desc).catch(() => {})
          changed = true
        }

        // If changed, attempt to demote author (if Baileys provides author data)
        if (changed && author) {
          const metadata = await sock.groupMetadata(jid).catch(() => null)
          if (metadata) {
            const botData = metadata.participants.find(p => normalizeJid(p.id) === botJid)
            
            if (botData?.admin) {
              const authorData = metadata.participants.find(p => 
                normalizeJid(p.id) === author || normalizeJid(p.phoneNumber) === author
              )
              
              if (authorData?.admin && authorData.admin !== 'superadmin') {
                await sock.groupParticipantsUpdate(jid, [authorData.id], 'demote').catch(() => {})
              }
            }
          }

          await sock.sendMessage(jid, {
            text: `⚠️ *${toSmallCaps('group protection triggered!')}*\n\n` +
                  `@${author.split('@')[0]} ${toSmallCaps('tried to change the group info. changes were reverted and the admin was demoted.')}`,
            mentions: [author]
          }).catch(() => {})
        }
      }
    })
  }
}

export default gcprotectCommand
