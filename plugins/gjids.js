export default {
  command: ['gjids],
  category: 'owner',

  description:
    'Show all groups with their names and JIDs',

  async run({
    sock,
    message,
    isOwner
  }) {
    if (!isOwner) return

    const chatJid = message.key.remoteJid

    try {
      const groups = await sock.groupFetchAllParticipating()

      const groupList = Object.values(groups)

      if (!groupList.length) {
        return await sock.sendMessage(
          chatJid,
          {
            text: '❌ ɴᴏ ɢʀᴏᴜᴘs ꜰᴏᴜɴᴅ.'
          },
          {
            quoted: message
          }
        )
      }

      groupList.sort((a, b) =>
        (a.subject || '').localeCompare(
          b.subject || ''
        )
      )

      let text =
        `╭━━━〔 𝐑ᴀᴢᴀ-𝐌ᴅ 𝐆ʀᴏᴜᴘs 〕━━━╮\n\n`

      groupList.forEach((group, index) => {
        text +=
          `╭─〔 ${index + 1} 〕\n` +
          `│ ɴᴀᴍᴇ: ${group.subject || 'Unknown'}\n` +
          `│ ᴊɪᴅ: ${group.id}\n` +
          `╰──────────────\n\n`
      })

      text +=
        `ᴛᴏᴛᴀʟ ɢʀᴏᴜᴘs: ${groupList.length}`

      await sock.sendMessage(
        chatJid,
        {
          text
        },
        {
          quoted: message
        }
      )
    } catch (error) {
      console.error('[GROUPS]', error)

      await sock.sendMessage(
        chatJid,
        {
          text:
            '❌ ꜰᴀɪʟᴇᴅ ᴛᴏ ꜰᴇᴛᴄʜ ɢʀᴏᴜᴘ ʟɪsᴛ.'
        },
        {
          quoted: message
        }
      )
    }
  }
}
