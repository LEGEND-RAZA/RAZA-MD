import { jidNormalizedUser } from '@whiskeysockets/baileys'

function toSmallCaps(text) {
  const map = {
    a: '\u1D00', b: '\u0299', c: '\u1D04', d: '\u1D05', e: '\u1D07',
    f: '\u0493', g: '\u0262', h: '\u029C', i: '\u026A', j: '\u1D0A',
    k: '\u1D0B', l: '\u029F', m: '\u1D0D', n: '\u0274', o: '\u1D0F',
    p: '\u1D18', q: '\u01FA', r: '\u0280', s: 's',      t: '\u1D1B',
    u: '\u1D1C', v: '\u1D20', w: '\u1D21', x: 'x',      y: '\u028F',
    z: '\u1D22'
  }
  return String(text || '').toLowerCase().split('').map((c) => map[c] || c).join('')
}

export default {
  command: ['dll'],
  category: 'group',
  description: 'Demote all admins',

  async run({ sock, message, isOwner, isGroup }) {
    if (!isOwner) return

    const jid = message?.key?.remoteJid
    if (!jid) return

    if (!isGroup) {
      return await sock.sendMessage(jid, {
        text: `❌ ${toSmallCaps('this command only works in groups')}`
      }, { quoted: message })
    }

    try {
      const group = await sock.groupMetadata(jid)

      const botId = sock.user?.id ? jidNormalizedUser(sock.user.id) : ''
      const botLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : ''

      // 🚀 FIX: Check id, lid, and phoneNumber to find the bot in the group
      const botParticipant = group.participants.find(participant => {
        const pId = participant.id ? jidNormalizedUser(participant.id) : ''
        const pPhone = participant.phoneNumber ? jidNormalizedUser(participant.phoneNumber) : ''
        const pLid = participant.lid ? jidNormalizedUser(participant.lid) : ''

        return (pId === botId || pId === botLid || pPhone === botId || pLid === botId)
      })

      if (!botParticipant || !botParticipant.admin) {
        return await sock.sendMessage(jid, {
          text: `❌ ${toSmallCaps('bot must be admin to demote admins')}`
        }, { quoted: message })
      }

      // 🚀 FIX: Get the real ID of the bot to exclude it from the demote list
      const realBotId = botParticipant.id || botParticipant.phoneNumber

      const admins = group.participants
        .filter(participant => {
          if (!participant.admin) return false
          
          const pId = participant.id ? jidNormalizedUser(participant.id) : ''
          const pPhone = participant.phoneNumber ? jidNormalizedUser(participant.phoneNumber) : ''
          const pLid = participant.lid ? jidNormalizedUser(participant.lid) : ''
          
          // Skip the bot itself
          if (
            pId === jidNormalizedUser(realBotId) ||
            pPhone === jidNormalizedUser(realBotId) ||
            pLid === jidNormalizedUser(realBotId)
          ) {
            return false
          }
          
          return true
        })
        .map(participant => participant.id) // Pass the raw ID to Baileys

      if (!admins.length) {
        return await sock.sendMessage(jid, {
          text: `❌ ${toSmallCaps('no admins to demote')}`
        }, { quoted: message })
      }

      await sock.groupParticipantsUpdate(jid, admins, 'demote')

      return await sock.sendMessage(jid, {
        text: `✅ ${toSmallCaps('demoted')} *${admins.length}* ${toSmallCaps('admins')}`
      }, { quoted: message })

    } catch (error) {
      console.error('[DLL] Error:', error?.message || error)

      return await sock.sendMessage(jid, {
        text: `❌ ${toSmallCaps('demote failed')}\n\n${error?.message || error}`
      }, { quoted: message })
    }
  }
}
