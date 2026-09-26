export default {
  command: ['kall'],

  description:
    'Kick all non-admin members',

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

      const users =
        group.participants
          .filter(
            participant =>
              !participant.admin
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