import { jidNormalizedUser } from '@whiskeysockets/baileys'

export default {
  command: ['dll'],
  category: 'group',

  description:
    'Demote all admins',

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
        sock.user?.id
          ? jidNormalizedUser(sock.user.id)
          : ''

      const botParticipant =
        group.participants.find(
          participant =>
            jidNormalizedUser(
              participant.id
            ) === botJid
        )

      if (
        !botParticipant ||
        !botParticipant.admin
      ) {
        return await sock.sendMessage(
          jid,
          {
            text:
              '❌ 𝐁ᴏᴛ 𝐌ᴜsᴛ 𝐁ᴇ 𝐀ᴅᴍɪɴ 𝐓ᴏ 𝐃ᴇᴍᴏᴛᴇ 𝐀ᴅᴍɪɴs'
          },
          {
            quoted: message
          }
        )
      }

      const admins =
        group.participants
          .filter(
            participant =>
              participant.admin &&
              jidNormalizedUser(
                participant.id
              ) !== botJid
          )
          .map(
            participant =>
              participant.id
          )

      if (!admins.length) {
        return await sock.sendMessage(
          jid,
          {
            text:
              '❌ 𝐍ᴏ 𝐀ᴅᴍɪɴs 𝐓ᴏ 𝐃ᴇᴍᴏᴛᴇ'
          },
          {
            quoted: message
          }
        )
      }

      await sock.groupParticipantsUpdate(
        jid,
        admins,
        'demote'
      )

      return await sock.sendMessage(
        jid,
        {
          text:
            `✅ 𝐃ᴇᴍᴏᴛᴇᴅ *${admins.length}* 𝐀ᴅᴍɪɴs`
        },
        {
          quoted: message
        }
      )

    } catch (error) {
      console.error(
        '[DLL] Error:',
        error?.message || error
      )

      return await sock.sendMessage(
        jid,
        {
          text:
            `❌ 𝐃ᴇᴍᴏᴛᴇ 𝐅ᴀɪʟᴇᴅ\n\n${
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
