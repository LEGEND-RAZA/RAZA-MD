import {
  getAlwaysOnline,
  setAlwaysOnline,
  startAlwaysOnline,
  stopAlwaysOnline
} from '../handler.js'

export default {
  command: 'alwaysonline',

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
      setAlwaysOnline(true)

      await startAlwaysOnline(
        sock
      )

      return await sock.sendMessage(
        jid,
        {
          text:
            '✅ ᴀʟᴡᴀʏs ᴏɴʟɪɴᴇ ᴇɴᴀʙʟᴇᴅ'
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
      setAlwaysOnline(false)

      await stopAlwaysOnline(
        sock
      )

      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ ᴀʟᴡᴀʏs ᴏɴʟɪɴᴇ ᴅɪsᴀʙʟᴇᴅ'
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
          `╭─❒ ᴀʟᴡᴀʏs ᴏɴʟɪɴᴇ ❒\n` +
          `│ sᴛᴀᴛᴜs: ${
            getAlwaysOnline()
              ? 'ᴏɴ'
              : 'ᴏғғ'
          }\n` +
          `│\n` +
          `│ .alwaysonline on\n` +
          `│ .alwaysonline off\n` +
          `╰────────────`
      },
      {
        quoted: message
      }
    )
  }
}