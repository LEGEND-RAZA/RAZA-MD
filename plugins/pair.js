export const plugin = {
  command: ['pair'],
  category: 'owner',

  async run({
    sock,
    message,
    args,
    isOwner
  }) {
    if (!isOwner) return

    const jid =
      message?.key?.remoteJid

    if (!jid) return

    /*
     * ==============================
     * GET NUMBER
     * ==============================
     */

    let number =
      String(args?.[0] || '')
        .replace(/\D/g, '')

    if (!number) {
      const context =
        message?.message
          ?.extendedTextMessage
          ?.contextInfo

      const quotedParticipant =
        context?.participantPn ||
        context?.participant ||
        context?.remoteJid

      if (quotedParticipant) {
        number =
          String(quotedParticipant)
            .split('@')[0]
            .split(':')[0]
            .replace(/\D/g, '')
      }

      if (!number) {
        const quoted =
          context?.quotedMessage

        if (quoted) {
          const quotedKey =
            quoted?.key || {}

          const quotedSender =
            quotedKey.participantPn ||
            quotedKey.participant ||
            quotedKey.remoteJid

          if (quotedSender) {
            number =
              String(quotedSender)
                .split('@')[0]
                .split(':')[0]
                .replace(/\D/g, '')
          }
        }
      }
    }

    if (
      number.length < 7 ||
      number.length > 15
    ) {
      return sock.sendMessage(
        jid,
        {
          text:
            '❌ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴘᴇʀsᴏɴ\'s ᴍᴇssᴀɢᴇ ᴏʀ ᴜsᴇ:\n\n.ᴘᴀɪʀ 923xxxxxxxxx'
        },
        {
          quoted: message
        }
      )
    }

    const baseUrl =
      String(
        process.env.PAIR_SERVER_URL ||
        'https://pair-web-3e08f4e68faf.herokuapp.com'
      ).replace(/\/+$/, '')

    try {
      await sock.sendMessage(
        jid,
        {
          text:
            `⏳ ʀᴇǫᴜᴇsᴛɪɴɢ ᴘᴀɪʀɪɴɢ ᴄᴏᴅᴇ...\n\n📱 ${number}`
        },
        {
          quoted: message
        }
      )

      const response =
        await fetch(
          `${baseUrl}/api/pair`,
          {
            method: 'POST',
            headers: {
              'content-type':
                'application/json'
            },
            body:
              JSON.stringify({
                number
              })
          }
        )

      const data =
        await response.json()

      if (
        !response.ok ||
        !data?.success
      ) {
        return sock.sendMessage(
          jid,
          {
            text:
              `❌ ᴘᴀɪʀɪɴɢ ғᴀɪʟᴇᴅ\n\n${data?.error || 'ᴜɴᴋɴᴏᴡɴ ᴇʀʀᴏʀ'}`
          },
          {
            quoted: message
          }
        )
      }

      const jobId =
        data.id

      if (!jobId) {
        return sock.sendMessage(
          jid,
          {
            text:
              '❌ ɴᴏ ᴘᴀɪʀɪɴɢ ᴊᴏʙ ɪᴅ ʀᴇᴛᴜʀɴᴇᴅ.'
          },
          {
            quoted: message
          }
        )
      }

      let code =
        data.code || ''

      let status =
        data.status || ''

      for (
        let i = 0;
        i < 30 && !code;
        i++
      ) {
        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              1000
            )
        )

        try {
          const result =
            await fetch(
              `${baseUrl}/api/status/${encodeURIComponent(jobId)}`
            )

          const current =
            await result.json()

          code =
            current?.code || ''

          status =
            current?.status ||
            status

          if (
            status === 'error'
          ) {
            return sock.sendMessage(
              jid,
              {
                text:
                  `❌ ᴘᴀɪʀɪɴɢ ғᴀɪʟᴇᴅ\n\n${current?.error || 'ᴜɴᴋɴᴏᴡɴ ᴇʀʀᴏʀ'}`
              },
              {
                quoted: message
              }
            )
          }
        } catch {}
      }

      if (!code) {
        return sock.sendMessage(
          jid,
          {
            text:
              '❌ ᴘᴀɪʀɪɴɢ ᴄᴏᴅᴇ ᴡᴀs ɴᴏᴛ ʀᴇᴄᴇɪᴠᴇᴅ.'
          },
          {
            quoted: message
          }
        )
      }

      await sock.sendMessage(
        jid,
        {
          text:
            `╭─❒ 𝐑ᴀᴢᴀ 𝐏ᴀɪʀ ❒\n` +
            `│\n` +
            `│ 𝐍ᴜᴍʙᴇʀ : ${number}\n` +
            `│ 𝐒ᴛᴀᴛᴜs : ${status || 'waiting'}\n` +
            `╰──────────────`
        },
        {
          quoted: message
        }
      )

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            500
          )
      )

      await sock.sendMessage(
        jid,
        {
          text: code
        },
        {
          quoted: message
        }
      )

      let session = ''

      for (
        let i = 0;
        i < 35 && !session;
        i++
      ) {
        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              2000
            )
        )

        try {
          const result =
            await fetch(
              `${baseUrl}/api/status/${encodeURIComponent(jobId)}`
            )

          const current =
            await result.json()

          session =
            current?.session || ''

          if (
            current?.status ===
            'error'
          ) {
            break
          }
        } catch {}
      }

      if (session) {
        await sock.sendMessage(
          jid,
          {
            text:
              `✓ 𝐒ᴇssɪᴏɴ 𝐑ᴇᴀᴅʏ\n\n${session}`
          },
          {
            quoted: message
          }
        )
      }
    } catch (error) {
      console.error(
        '[PAIR PLUGIN]',
        error?.message ||
        error
      )

      await sock.sendMessage(
        jid,
        {
          text:
            `❌ ᴘᴀɪʀɪɴɢ ᴇʀʀᴏʀ\n\n${error?.message || 'ᴜɴᴋɴᴏᴡɴ ᴇʀʀᴏʀ'}`
        },
        {
          quoted: message
        }
      )
    }
  }
}
