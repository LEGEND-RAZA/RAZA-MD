export default {
  command: ['groups'],
  description: 'Show total groups',

  async run({ sock, message, isOwner }) {
    if (!isOwner) return

    try {
      const groups =
        await sock.groupFetchAllParticipating()

      const total =
        Object.keys(groups).length

      return await sock.sendMessage(
        message.key.remoteJid,
        {
          text:
            `╭━━━〔 𝐆ʀᴏᴜᴘs 〕━━━┈⊷\n` +
            `┃\n` +
            `┃ 𝐓ᴏᴛᴀʟ 𝐆ʀᴏᴜᴘs : ${total}\n` +
            `┃\n` +
            `╰━━━━━━━━━━━━━━━━━━━━┈⊷`
        },
        {
          quoted: message
        }
      )
    } catch (error) {
      return await sock.sendMessage(
        message.key.remoteJid,
        {
          text:
            `❌ 𝐅ᴀɪʟᴇᴅ 𝐓ᴏ 𝐆ᴇᴛ 𝐆ʀᴏᴜᴘs\n\n${
              error?.message || error
            }`
        },
        {
          quoted: message
        }
      )
    }
  }
}