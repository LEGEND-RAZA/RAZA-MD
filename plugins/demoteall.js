export default {
  command: ['dll'],

  description:
    'Demote all admins',

  async run({
    sock,
    message,
    isOwner,
    isGroup
  }) {
    if (!isOwner) return

    if (!isGroup) {
      return await sock.sendMessage(
        message.key.remoteJid,
        {
          text:
            '❌ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ 𝐎ɴʟʏ 𝐖ᴏʀᴋs 𝐈ɴ 𝐆ʀᴏᴜᴘs'
        },
        {
          quoted: message
        }
      )
    }

    const jid =
      message.key.remoteJid

    try {
      const group =
        await sock.groupMetadata(jid)

      const botJid =
        sock.user?.id
          ? sock.user.id.split(':')[0] +
            '@s.whatsapp.net'
          : ''

      const admins =
        group.participants
          .filter(
            participant =>
              participant.admin &&
              participant.id !== botJid
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