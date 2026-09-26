export default {
  command: [
    'restart',
    'reboot',
    'shutdown'
  ],

  description:
    'Restart or shutdown the bot',

  async run({
    sock,
    message,
    command,
    isOwner
  }) {

    const jid =
      message.key.remoteJid

    if (!isOwner) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ 𝐎ɴʟʏ 𝐎ᴡɴᴇʀ 𝐂ᴀɴ 𝐔sᴇ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ'
        },
        {
          quoted: message
        }
      )
    }

    if (
      command === 'shutdown'
    ) {
      await sock.sendMessage(
        jid,
        {
          text:
            '🛑 𝐒ʜᴜᴛᴛɪɴɢ 𝐃ᴏᴡɴ 𝐑ᴀᴢᴀ-𝐌ᴅ...'
        },
        {
          quoted: message
        }
      )

      setTimeout(() => {
        process.exit(0)
      }, 1000)

      return
    }

    await sock.sendMessage(
      jid,
      {
        text:
          '🔄 𝐑ᴇsᴛᴀʀᴛɪɴɢ 𝐑ᴀᴢᴀ-𝐌ᴅ...'
      },
      {
        quoted: message
      }
    )

    setTimeout(() => {
      process.exit(0)
    }, 1000)
  }
}