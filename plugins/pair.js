export default {
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

    const number =
      String(
        args?.[0] || ''
      ).replace(
        /\D/g,
        ''
      )

    if (
      number.length < 7 ||
      number.length > 15
    ) {
      return sock.sendMessage(
        jid,
        {
          text:
            '❌ ᴜsᴇ: .ᴘᴀɪʀ 923xxxxxxxxx'
        },
        {
          quoted:
            message
        }
      )
    }

    const baseUrl =
      String(
        process.env.PAIR_SERVER_URL ||
          'https://pair-web-3e08f4e68faf.herokuapp.com'
      ).replace(
        /\/+$/,
        ''
      )

    try {
      const response =
        await fetch(
          `${baseUrl}/api/pair`,
          {
            method:
              'POST',

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
            quoted:
              message
          }
        )
      }

      const jobId =
        data.id

      let code =
        data.code || ''

      let status =
        data.status || ''

      for (
        let i = 0;
        i < 20 && !code;
        i++
      ) {
        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              1000
            )
        )

        const statusResponse =
          await fetch(
            `${baseUrl}/api/status/${encodeURIComponent(jobId)}`
          )

        const statusData =
          await statusResponse.json()

        code =
          statusData?.code ||
          ''

        status =
          statusData?.status ||
          status

        if (
          status ===
            'error'
        ) {
          return sock.sendMessage(
            jid,
            {
              text:
                `❌ ᴘᴀɪʀɪɴɢ ғᴀɪʟᴇᴅ\n\n${statusData?.error || 'ᴘᴀɪʀɪɴɢ ᴄᴏᴜʟᴅ ɴᴏᴛ ʙᴇ sᴛᴀʀᴛᴇᴅ'}`
            },
            {
              quoted:
                message
            }
          )
        }
      }

      if (!code) {
        return sock.sendMessage(
          jid,
          {
            text:
              '⏳ ᴘᴀɪʀɪɴɢ ᴄᴏᴅᴇ ɪs ɴᴏᴛ ʀᴇᴀᴅʏ ʏᴇᴛ.\n\nᴘʟᴇᴀsᴇ ᴛʀʏ ᴀɢᴀɪɴ ɪɴ ᴀ ғᴇᴡ sᴇᴄᴏɴᴅs.'
          },
          {
            quoted:
              message
            }
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
            `│ 𝐒ᴛᴀᴛᴜs  : ${status || 'waiting'}\n` +
            `│\n` +
            `╰──────────────`
        },
        {
          quoted:
            message
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
          text:
            code
        }
      )

      let session = ''

      for (
        let i = 0;
        i < 30 && !session;
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
          const statusResponse =
            await fetch(
              `${baseUrl}/api/status/${encodeURIComponent(jobId)}`
            )

          const statusData =
            await statusResponse.json()

          session =
            statusData?.session ||
            ''
        } catch {}
      }

      if (session) {
        await sock.sendMessage(
          jid,
          {
            text:
              `✓ 𝐒ᴇssɪᴏɴ 𝐑ᴇᴀᴅʏ\n\n${session}`
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
          quoted:
            message
        }
      )
    }
  }
}
