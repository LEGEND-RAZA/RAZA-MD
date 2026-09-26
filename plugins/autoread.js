import {
  getAutoRead,
  setAutoRead
} from '../handler.js'

export default {
  command: 'autoread',

  async run({
    sock,
    message,
    args
  }) {
    const jid =
      message.key.remoteJid

    const action =
      args[0]?.toLowerCase()

    if (
      action === 'on' ||
      action === 'enable'
    ) {
      setAutoRead(true)

      return await sock.sendMessage(
        jid,
        {
          text:
            '✅ ᴀᴜᴛᴏ ʀᴇᴀᴅ ᴇɴᴀʙʟᴇᴅ'
        },
        {
          quoted: message
        }
      )
    }

    if (
      action === 'off' ||
      action === 'disable'
    ) {
      setAutoRead(false)

      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ ᴀᴜᴛᴏ ʀᴇᴀᴅ ᴅɪsᴀʙʟᴇᴅ'
        },
        {
          quoted: message
        }
      )
    }

    return await sock.sendMessage(
      jid,
      {
        text:
          `╭─❒ ᴀᴜᴛᴏ ʀᴇᴀᴅ ❒\n` +
          `│ sᴛᴀᴛᴜs: ${
            getAutoRead()
              ? 'ᴏɴ'
              : 'ᴏғғ'
          }\n` +
          `│\n` +
          `│ .autoread on\n` +
          `│ .autoread off\n` +
          `╰────────────`
      },
      {
        quoted: message
      }
    )
  }
}