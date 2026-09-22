import { downloadMediaMessage } from '@whiskeysockets/baileys'

// Clean Unicode Escape Map for Small Caps
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

export default {
  command: [
    'join', 'left', 'promote', 'demote', 'kick', 'remove', 
    'mute', 'unmute', 'invite', 'grouplink',
    'setgname', 'setgdesc', 'gpp'
  ],
  description: 'Streamlined group management commands',
  async run({ sock, message, args, text, command, isGroup, isOwner }) {
    const jid = message.key.remoteJid

    // 1. JOIN COMMAND (Owner only - Works anywhere)
    if (command === 'join') {
      if (!isOwner) return

      const link = args[0]
      if (!link) {
        return await sock.sendMessage(
          jid,
          { text: `⚠️ ${toSmallCaps('please provide a group invite link.')}` },
          { quoted: message }
        )
      }

      const match = link.match(/chat\.whatsapp\.com\/([0-9A-Za-z]{20,24})/)
      if (!match || !match[1]) {
        return await sock.sendMessage(
          jid,
          { text: `❌ ${toSmallCaps('invalid whatsapp group invite link.')}` },
          { quoted: message }
        )
      }

      const inviteCode = match[1]

      try {
        await sock.groupAcceptInvite(inviteCode)
        return await sock.sendMessage(
          jid,
          { text: `✅ ${toSmallCaps('successfully joined the group.')}` },
          { quoted: message }
        )
      } catch (e) {
        console.error('[JOIN ERROR]:', e)
        return await sock.sendMessage(
          jid,
          { text: `❌ ${toSmallCaps('failed to join group. link may be invalid or expired.')}` },
          { quoted: message }
        )
      }
    }

    // Guard: Group context required for all commands below
    if (!isGroup) {
      return await sock.sendMessage(
        jid,
        { text: `❌ ${toSmallCaps('this command can only be used in groups.')}` },
        { quoted: message }
      )
    }

    // 2. INVITE / GROUPLINK COMMAND (Returns group invite link directly)
    if (['invite', 'grouplink'].includes(command)) {
      try {
        const code = await sock.groupInviteCode(jid)
        return await sock.sendMessage(
          jid,
          { text: `https://chat.whatsapp.com/${code}` },
          { quoted: message }
        )
      } catch (err) {
        console.error('[GROUP INVITE ERROR]:', err)
        return await sock.sendMessage(
          jid,
          { text: `❌ ${toSmallCaps('failed to fetch group link. make sure the bot is an admin in this group.')}` },
          { quoted: message }
        )
      }
    }

    // Helper: Check admin status safely for administrative actions
    const groupMetadata = await sock.groupMetadata(jid).catch(() => null)
    if (!groupMetadata) return

    const sender = message.key.participant || jid
    const isAdmin = groupMetadata.participants.some((p) => p.id === sender && p.admin !== null)

    if (!isAdmin && !isOwner) {
      return await sock.sendMessage(
        jid,
        { text: `❌ ${toSmallCaps('only group admins can use this command.')}` },
        { quoted: message }
      )
    }

    // 3. LEAVE COMMAND
    if (command === 'left') {
      await sock.sendMessage(jid, { text: `👋 ${toSmallCaps('leaving group...')}` })
      await sock.groupLeave(jid).catch(() => {})
      return
    }

    // 4. MUTE & UNMUTE COMMANDS
    if (command === 'mute' || command === 'unmute') {
      const setting = command === 'mute' ? 'announcement' : 'not_announcement'
      try {
        await sock.groupSettingUpdate(jid, setting)
        const statusText = command === 'mute' 
          ? `🔒 ${toSmallCaps('group muted. only admins can send messages.')}`
          : `🔓 ${toSmallCaps('group unmuted. all members can send messages.')}`
        return await sock.sendMessage(jid, { text: statusText }, { quoted: message })
      } catch (e) {
        return await sock.sendMessage(
          jid,
          { text: `❌ ${toSmallCaps('failed to update group settings. ensure bot is admin.')}` },
          { quoted: message }
        )
      }
    }

    // 5. PROMOTE, DEMOTE & KICK/REMOVE COMMANDS
    if (['promote', 'demote', 'kick', 'remove'].includes(command)) {
      let target =
        message.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
        message.message?.extendedTextMessage?.contextInfo?.participant

      if (!target && args[0]) {
        target = args[0].replace(/\D/g, '') + '@s.whatsapp.net'
      }

      if (!target || target === '@s.whatsapp.net') {
        return await sock.sendMessage(
          jid,
          { text: `⚠️ ${toSmallCaps('please mention a user or reply to a message.')}` },
          { quoted: message }
        )
      }

      let action = command === 'promote' ? 'promote' : 'demote'
      if (command === 'kick' || command === 'remove') {
        action = 'remove'
      }

      try {
        await sock.groupParticipantsUpdate(jid, [target], action)
        const actionText = 
          action === 'promote' ? 'promoted to admin' : 
          action === 'demote' ? 'demoted from admin' : 'removed from group'

        return await sock.sendMessage(
          jid,
          { text: `✅ ${toSmallCaps(`user successfully ${actionText}.`)}` },
          { quoted: message }
        )
      } catch (e) {
        return await sock.sendMessage(
          jid,
          { text: `❌ ${toSmallCaps('action failed. ensure bot is an admin.')}` },
          { quoted: message }
        )
      }
    }

    // 6. CHANGE GROUP NAME (setgname)
    if (command === 'setgname') {
      if (!text) {
        return await sock.sendMessage(
          jid,
          { text: `⚠️ ${toSmallCaps('please provide a new group subject name.')}` },
          { quoted: message }
        )
      }
      try {
        await sock.groupUpdateSubject(jid, text)
        return await sock.sendMessage(
          jid,
          { text: `✅ ${toSmallCaps('group name successfully updated.')}` },
          { quoted: message }
        )
      } catch (e) {
        return await sock.sendMessage(
          jid,
          { text: `❌ ${toSmallCaps('failed to update group name. ensure bot is an admin.')}` },
          { quoted: message }
        )
      }
    }

    // 7. CHANGE GROUP DESCRIPTION (setgdesc)
    if (command === 'setgdesc') {
      if (!text) {
        return await sock.sendMessage(
          jid,
          { text: `⚠️ ${toSmallCaps('please provide a new group description.')}` },
          { quoted: message }
        )
      }
      try {
        await sock.groupUpdateDescription(jid, text)
        return await sock.sendMessage(
          jid,
          { text: `✅ ${toSmallCaps('group description successfully updated.')}` },
          { quoted: message }
        )
      } catch (e) {
        return await sock.sendMessage(
          jid,
          { text: `❌ ${toSmallCaps('failed to update group description. ensure bot is an admin.')}` },
          { quoted: message }
        )
      }
    }

    // 8. CHANGE GROUP PROFILE PICTURE (gpp)
    if (command === 'gpp') {
      const msgType = Object.keys(message.message || {})[0]
      const ctxInfo = message.message?.[msgType]?.contextInfo
      const quotedMsg = ctxInfo?.quotedMessage

      let targetMediaMessage = null

      if (quotedMsg) {
        const quotedType = Object.keys(quotedMsg)[0]
        if (quotedType === 'imageMessage') {
          targetMediaMessage = { message: quotedMsg }
        } else if (quotedType === 'ephemeralMessage' && quotedMsg.ephemeralMessage?.message?.imageMessage) {
          targetMediaMessage = { message: { imageMessage: quotedMsg.ephemeralMessage.message.imageMessage } }
        }
      } else if (msgType === 'imageMessage') {
        targetMediaMessage = message
      }

      if (!targetMediaMessage) {
        return await sock.sendMessage(
          jid,
          { text: `⚠️ ${toSmallCaps('please send an image or reply to an image with !gpp to update group icon.')}` },
          { quoted: message }
        )
      }

      try {
        const buffer = await downloadMediaMessage(targetMediaMessage, 'buffer', {})
        await sock.updateProfilePicture(jid, buffer)
        return await sock.sendMessage(
          jid,
          { text: `✅ ${toSmallCaps('group profile picture successfully updated.')}` },
          { quoted: message }
        )
      } catch (e) {
        console.error('[GROUP PP ERROR]:', e)
        return await sock.sendMessage(
          jid,
          { text: `❌ ${toSmallCaps('failed to update group icon. ensure bot is an admin.')}` },
          { quoted: message }
        )
      }
    }
  }
}