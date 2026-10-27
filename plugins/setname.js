/*
 * ==============================
 * SET WHATSAPP PROFILE NAME
 * ==============================
 * Changes the bot account's own display name shown to everyone on
 * WhatsApp. Uses sock.updateProfileName() — Baileys 7.x still exposes it.
 *
 * WhatsApp hard limit: 25 characters (server truncates anything longer).
 */

const MAX_NAME_LENGTH = 25

export default {
  command: ['setname'],
  category: 'owner',
  description: 'Change the bot WhatsApp profile name',

  async run({ sock, message, args, isOwner }) {
    try {
      const jid = message?.key?.remoteJid
      if (!jid) return

      const reply = (text) =>
        sock.sendMessage(jid, { text }, { quoted: message }).catch(() => {})

      if (!isOwner) {
        return reply('❌ ᴏɴʟʏ ᴛʜᴇ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴄʜᴀɴɢᴇ ᴛʜᴇ ʙᴏᴛ ɴᴀᴍᴇ')
      }

      const newName = String(args?.join(' ') || '').trim()

      if (!newName) {
        // Show current name when no argument provided
        const current = sock.user?.name || sock.user?.verifiedName || '(not set)'
        return reply(
          [
            '╭━━━〔 ᴡʜᴀᴛꜱᴀᴘᴘ ɴᴀᴍᴇ 〕',
            '│',
            `│ ᴄᴜʀʀᴇɴᴛ: ${current}`,
            '│',
            '│ ᴜꜱᴀɢᴇ',
            '│ .setname <new name>',
            '│',
            `│ ᴍᴀx ʟᴇɴɢᴛʜ: ${MAX_NAME_LENGTH} ᴄʜᴀʀꜱ`,
            '│',
            '╰━━━━━━━━━━━━━━━━━━'
          ].join('\n')
        )
      }

      if (newName.length > MAX_NAME_LENGTH) {
        return reply(
          `❌ ɴᴀᴍᴇ ᴛᴏᴏ ʟᴏɴɢ\n\n` +
          `ᴍᴀx ${MAX_NAME_LENGTH} ᴄʜᴀʀꜱ · ʏᴏᴜ ꜱᴇɴᴛ ${newName.length}`
        )
      }

      if (!sock.user?.id) {
        return reply('❌ ʙᴏᴛ ɴᴏᴛ ᴄᴏɴɴᴇᴄᴛᴇᴅ ᴛᴏ ᴡʜᴀᴛꜱᴀᴘᴘ')
      }

      try {
        await sock.updateProfileName(newName)

        // Update local user object so .setname status reflects immediately
        if (sock.user) sock.user.name = newName

        console.log(
          `[SETNAME] Updated bot name to "${newName}" (${newName.length} chars)`
        )

        return reply(
          `✅ ᴡʜᴀᴛꜱᴀᴘᴘ ɴᴀᴍᴇ ᴜᴘᴅᴀᴛᴇᴅ\n\n` +
          `ɴᴇᴡ ɴᴀᴍᴇ: *${newName}*`
        )
      } catch (e) {
        console.error('[SETNAME] updateProfileName failed:', e?.message || e)

        const msg = String(e?.message || e || '')
        let hint = ''

        if (/not-authorized|401|403/i.test(msg)) {
          hint = '\n\nᴛʜᴇ ꜱᴇꜱꜱɪᴏɴ ᴍᴀʏ ɴᴏ ʟᴏɴɢᴇʀ ʜᴀᴠᴇ ᴘᴇʀᴍɪꜱꜱɪᴏɴ. ʀᴇ-ᴘᴀɪʀ ᴛʜᴇ ʙᴏᴛ.'
        } else if (/rate|flood|too many/i.test(msg)) {
          hint = '\n\nᴛᴏᴏ ᴍᴀɴʏ ɴᴀᴍᴇ ᴄʜᴀɴɢᴇꜱ ʀᴇᴄᴇɴᴛʟʏ. ᴡᴀɪᴛ ᴀ ꜰᴇᴡ ᴍɪɴᴜᴛᴇꜱ.'
        }

        return reply(`❌ ꜰᴀɪʟᴇᴅ ᴛᴏ ᴜᴘᴅᴀᴛᴇ ɴᴀᴍᴇ\n\n${msg}${hint}`)
      }
    } catch (e) {
      console.error('[SETNAME] Command failed:', e?.message || e)
    }
  }
}
