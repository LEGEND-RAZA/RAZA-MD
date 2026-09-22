export default {
  command: ['gbc'],
  description: 'Broadcast a message to all participating groups',
  async run({ sock, message, text, isOwner }) {
    const jid = message.key.remoteJid

    // Only allow owner to broadcast
    if (!isOwner) {
      return await sock.sendMessage(
        jid,
        { text: '❌ 𝐎ɴʟʏ 𝐎ᴡɴᴇʀ 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ' },
        { quoted: message }
      )
    }

    if (!text) {
      return await sock.sendMessage(
        jid,
        { text: '⚠️ 𝐏ʟᴇᴀsᴇ 𝐏ʀᴏᴠɪᴅᴇ ᴀ 𝐌ᴇssᴀɢᴇ' },
        { quoted: message }
      )
    }

    try {
      // Fetch all participating groups
      const groupsMap = await sock.groupFetchAllParticipating()
      const groups = Object.values(groupsMap)

      if (groups.length === 0) {
        return await sock.sendMessage(
          jid,
          { text: '𝐍ᴏ 𝐆ʀᴏᴜᴘs 𝐅ᴏᴜɴᴅ.' },
          { quoted: message }
        )
      }

      await sock.sendMessage(
        jid,
        { text: `📢 𝐏ʀᴏᴄᴇssɪɴɢ 𝐓ᴏ ${groups.length} 𝐆ʀᴏᴜᴘs...` },
        { quoted: message }
      )

      let count = 0
      for (const group of groups) {
        try {
          const members = group.participants.map((p) => p.id)
          await sock.sendMessage(group.id, { text, mentions: members })
          count++

          // Small delay to prevent WhatsApp rate limits
          await new Promise((resolve) => setTimeout(resolve, 1000))
        } catch (e) {
          console.error(`𝐅ᴀɪʟᴇᴅ 𝐓ᴏ 𝐒ᴇɴᴅ ${group.id}:`, e.message)
        }
      }

      await sock.sendMessage(
        jid,
        { text: `✅ 𝐃ᴏɴᴇ ! 𝐒ᴇɴᴛ 𝐓ᴏ *${count}/${groups.length}* 𝐆ʀᴏᴜᴘs.` },
        { quoted: message }
      )
    } catch (e) {
      console.error('𝐄ʀᴇᴏʀ:', e)
      await sock.sendMessage(
        jid,
        { text: `❌ 𝐅ᴀɪʟᴇᴅ 𝐓ᴏ 𝐁ᴏᴀʀᴅᴄᴀsᴛ: ${e.message}` },
        { quoted: message }
      )
    }
  }
}