export default {
  command: ['kall'],
  category: 'group',

  description:
    'Kick all non-admin members',

  async run({
    sock,
    message,
    isOwner,
    isGroup
  }) {
    if (!isOwner) return

    const jid =
      message?.key?.remoteJid

    if (!jid) return

    if (!isGroup) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ 𝐎ɴʟʏ 𝐖ᴏʀᴋs 𝐈ɴ 𝐆ʀᴏᴜᴘs'
        },
        {
          quoted: message
        }
      )
    }

    try {
      const group =
        await sock.groupMetadata(jid)

      const botJid =
        sock?.user?.id
          ? sock.user.id.split(':')[0]
          : null

      const botParticipant =
        group.participants.find(
          participant => {
            const participantId =
              participant?.id?.split(':')[0]

            return (
              participantId === botJid
            )
          }
        )

      const botIsAdmin =
        botParticipant?.admin === 'admin' ||
        botParticipant?.admin === 'superadmin'

      if (!botIsAdmin) {
        return await sock.sendMessage(
          jid,
          {
            text:
              '❌ 𝐁ᴏᴛ 𝐈s 𝐍ᴏᴛ 𝐀ɴ 𝐀ᴅᴍɪɴ\n\n' +
              '𝐏ʀᴏᴍᴏᴛᴇ 𝐌ᴇ 𝐓ᴏ 𝐀ᴅᴍɪɴ 𝐁ᴇғᴏʀᴇ 𝐔sɪɴɢ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ.'
          },
          {
            quoted: message
          }
        )
      }

      const users =
        group.participants
          .filter(
            participant =>
              !participant.admin &&
              participant.id !== botParticipant?.id
          )
          .map(
            participant =>
              participant.id
          )

      if (!users.length) {
        return await sock.sendMessage(
          jid,
          {
            text:
              '❌ 𝐍ᴏ 𝐍ᴏɴ-𝐀ᴅᴍɪɴ 𝐌ᴇᴍʙᴇʀs 𝐓ᴏ 𝐊ɪᴄᴋ'
          },
          {
            quoted: message
          }
        )
      }

      await sock.groupParticipantsUpdate(
        jid,
        users,
        'remove'
      )

      return await sock.sendMessage(
        jid,
        {
          text:
            `✅ 𝐑ᴇᴍᴏᴠᴇᴅ *${users.length}* 𝐌ᴇᴍʙᴇʀs`
        },
        {
          quoted: message
        }
      )

    } catch (error) {
      console.error(
        '[KALL] Error:',
        error?.message || error
      )

      return await sock.sendMessage(
        jid,
        {
          text:
            `❌ 𝐊ɪᴄᴋ 𝐅ᴀɪʟᴇᴅ\n\n${
              error?.message ||
              error
            }`
        },
        {
          quoted: message
        }
      )
    }
  }
}
