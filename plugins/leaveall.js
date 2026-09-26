export default {
  command: ['leaveall'],

  description:
    'Leave all groups',

  async run({
    sock,
    message,
    isOwner
  }) {
    if (!isOwner) return

    const jid =
      message?.key?.remoteJid

    if (!jid) return

    try {
      const groups =
        Object.values(
          await sock.groupFetchAllParticipating()
        )

      const total =
        groups.length

      let left = 0

      const status =
        await sock.sendMessage(
          jid,
          {
            text:
              `𝐋ᴇᴀᴠɪɴɢ 𝐆ʀᴏᴜᴘs...\n0/${total}`
          }
        )

      for (const group of groups) {
        try {
          await sock.groupLeave(
            group.id
          )

          left++

          await sock.sendMessage(
            jid,
            {
              text:
                `𝐋ᴇᴀᴠɪɴɢ 𝐆ʀᴏᴜᴘs...\n${left}/${total}`,
              edit:
                status.key
            }
          ).catch(() => {})

        } catch {
          continue
        }
      }

      await sock.sendMessage(
        jid,
        {
          text:
            `✅ 𝐃ᴏɴᴇ! 𝐋ᴇғᴛ *${left}* 𝐆ʀᴏᴜᴘ(s).`,
          edit:
            status.key
        }
      ).catch(() => {})

    } catch (error) {
      console.error(
        '[LEAVEALL]',
        error?.stack ||
          error?.message ||
          error
      )

      await sock.sendMessage(
        jid,
        {
          text:
            '❌ 𝐄ʀʀᴏʀ 𝐋ᴇᴀᴠɪɴɢ 𝐆ʀᴏᴜᴘs'
        },
        {
          quoted: message
        }
      )
    }
  }
}