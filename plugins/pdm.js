import { getDb, saveDb } from '../database/index.js'

async function getSettings() {
  return await getDb('pdm.json', { enabledGroups: [] })
}

async function isEnabled(groupJid) {
  const data = await getSettings()
  const groups = Array.isArray(data.enabledGroups) ? data.enabledGroups : []
  return groups.includes(groupJid)
}

async function setEnabled(groupJid, value) {
  const data = await getSettings()
  let groups = Array.isArray(data.enabledGroups) ? data.enabledGroups : []
  
  if (value === true) {
    if (!groups.includes(groupJid)) groups.push(groupJid)
  } else {
    groups = groups.filter(jid => jid !== groupJid)
  }
  
  data.enabledGroups = groups
  await saveDb('pdm.json', data)
  return value
}

function cleanJid(jid) {
  if (!jid) return ''
  return String(jid).trim()
}

function mention(jid) {
  const value = cleanJid(jid)
  if (!value) return '@unknown'
  const number = value.split('@')[0].split(':')[0].replace(/\D/g, '')
  return number ? `@${number}` : '@unknown'
}

export default {
  command: 'pdm',
  category: 'group',

  async run({ sock, message, args }) {
    const jid = message?.key?.remoteJid
    if (!jid) return

    const action = args?.[0]?.toLowerCase()
    
    // 🚀 Check if a custom group JID was provided (e.g., .pdm on 123@g.us)
    let targetJid = args?.[1]
    
    // Fallback: If no custom JID is provided, use the current chat if it's a group
    if (!targetJid && jid.endsWith('@g.us')) {
      targetJid = jid
    }

    // If still no valid group JID, throw an error
    if (targetJid && !targetJid.endsWith('@g.us')) {
       return await sock.sendMessage(jid, {
        text: '❌ ɪɴᴠᴀʟɪᴅ ɢʀᴏᴜᴘ ᴊɪᴅ. ɪᴛ ᴍᴜsᴛ ᴇɴᴅ ᴡɪᴛʜ @g.us'
      }, { quoted: message })
    }

    if (action === 'on' || action === 'enable') {
      if (!targetJid) {
        return await sock.sendMessage(jid, {
          text: `⚠️ ᴜsᴀɢᴇ: .pdm on <ɢʀᴏᴜᴘ_ᴊɪᴅ>\nᴇxᴀᴍᴘʟᴇ: .pdm on 120363xxxx@g.us\n\n(ᴏʀ ᴜsᴇ .pdm on ɪɴsɪᴅᴇ ᴀ ɢʀᴏᴜᴘ)`
        }, { quoted: message })
      }
      
      await setEnabled(targetJid, true)
      return await sock.sendMessage(jid, {
        text: `✅ ᴘᴅᴍ ᴀʟᴇʀᴛ ᴇɴᴀʙʟᴇᴅ ꜰᴏʀ ɢʀᴏᴜᴘ:\n${targetJid}`
      }, { quoted: message })
    }

    if (action === 'off' || action === 'disable') {
      if (!targetJid) {
        return await sock.sendMessage(jid, {
          text: `⚠️ ᴜsᴀɢᴇ: .pdm off <ɢʀᴏᴜᴘ_ᴊɪᴅ>\nᴇxᴀᴍᴘʟᴇ: .pdm off 120363xxxx@g.us`
        }, { quoted: message })
      }

      await setEnabled(targetJid, false)
      return await sock.sendMessage(jid, {
        text: `❌ ᴘᴅᴍ ᴀʟᴇʀᴛ ᴅɪsᴀʙʟᴇᴅ ꜰᴏʀ ɢʀᴏᴜᴘ:\n${targetJid}`
      }, { quoted: message })
    }

    // Status check
    const status = targetJid && (await isEnabled(targetJid)) ? 'ᴏɴ' : 'ᴏғғ'
    const displayJid = targetJid || 'ɴᴏ ᴛᴀʀɢᴇᴛ ɢʀᴏᴜᴘ'

    return await sock.sendMessage(jid, {
      text:
        `╭─❒ ᴘᴅᴍ ᴀʟᴇʀᴛ ❒\n` +
        `│\n` +
        `│ ɢʀᴏᴜᴘ: ${displayJid}\n` +
        `│ sᴛᴀᴛᴜs: ${status}\n` +
        `│\n` +
        `│ .pdm on <ɢʀᴏᴜᴘ_ᴊɪᴅ>\n` +
        `│ .pdm off <ɢʀᴏᴜᴘ_ᴊɪᴅ>\n` +
        `│ .pdm on (ɪɴsɪᴅᴇ ɢʀᴏᴜᴘ)\n` +
        `╰────────────`
    }, { quoted: message })
  }
}

/*
 * ==============================
 * PDM GROUP EVENT LISTENER
 * ==============================
 */

export const pdmListener = {
  isGroupEvent: true,

  async run({ sock, update }) {
    if (!update) return

    const groupJid = update.id
    if (!groupJid || !String(groupJid).endsWith('@g.us')) return

    // Check if it's enabled for THIS specific group
    if (!(await isEnabled(groupJid))) {
      return
    }

    const action = update.action
    if (action !== 'promote' && action !== 'demote') return

    const participants = Array.isArray(update.participants) ? update.participants : []
    if (!participants.length) return

    const actor = update.author || update.actor || update.participant || ''

    const actionText = action === 'promote' ? 'ᴘʀᴏᴍᴏᴛᴇᴅ' : 'ᴅᴇᴍᴏᴛᴇᴅ'
    const icon = action === 'promote' ? '⬆️' : '⬇️'

    const targetMentions = participants.map((participant) =>
      cleanJid(
        typeof participant === 'string'
          ? participant
          : participant?.jid || participant?.id || participant?.lid || participant?.phoneNumber || ''
      )
    ).filter(Boolean)

    const actorJid = cleanJid(actor)
    const mentions = [...(actorJid ? [actorJid] : []), ...targetMentions]
    const uniqueMentions = [...new Set(mentions)]

    const targets = targetMentions.map((participant) => `│ 👤 ${mention(participant)}`).join('\n')

    const text =
      `╭─❒ ${icon} ᴘᴅᴍ ᴀʟᴇʀᴛ ❒\n` +
      `│\n` +
      `│ ᴀᴄᴛɪᴏɴ: ${actionText}\n` +
      `│ ʙʏ: ${mention(actorJid)}\n` +
      `│\n` +
      `${targets}\n` +
      `│\n` +
      `╰────────────`

    try {
      await sock.sendMessage(groupJid, { text, mentions: uniqueMentions })
      console.log(`[PDM] ${action} alert sent → ${groupJid}`)
    } catch (error) {
      console.error('[PDM SEND ERROR]', error?.message || error)
    }
  }
}
