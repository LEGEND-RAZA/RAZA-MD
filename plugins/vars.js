import fs from 'node:fs'
import path from 'node:path'

export default {
  command: ['setvar', 'delvar'],
  category: 'owner',
  description: 'Manage environment variables',

  async run({
    sock,
    message,
    args,
    command,
    isOwner
  }) {
    if (!isOwner) return

    const jid =
      message?.key?.remoteJid

    if (!jid) return

    const envPath =
      path.join(
        process.cwd(),
        '.env'
      )

    try {
      let env =
        fs.existsSync(envPath)
          ? fs.readFileSync(envPath, 'utf8')
          : ''

      /*
       * DELETE VAR
       */

      if (command === 'delvar') {
        const name =
          args?.[0]
            ?.trim()
            .toUpperCase()

        if (!name) {
          return await sock.sendMessage(
            jid,
            {
              text:
                '❌ ᴜsᴀɢᴇ\n\n' +
                '.ᴅᴇʟᴠᴀʀ <ɴᴀᴍᴇ>\n\n' +
                'ᴇxᴀᴍᴘʟᴇ:\n' +
                '.ᴅᴇʟᴠᴀʀ ʜᴇʀᴏᴋᴜ_ᴀᴘɪ_ᴋᴇʏ'
            },
            {
              quoted: message
            }
          )
        }

        if (
          !/^[A-Z_$][A-Z0-9_$]*$/i.test(name)
        ) {
          return await sock.sendMessage(
            jid,
            {
              text:
                '❌ ɪɴᴠᴀʟɪᴅ ᴠᴀʀɪᴀʙʟᴇ ɴᴀᴍᴇ'
            },
            {
              quoted: message
            }
          )
        }

        const regex =
          new RegExp(
            `^\\s*${name}\\s*=.*(?:\\r?\\n|$)`,
            'gim'
          )

        if (!regex.test(env)) {
          return await sock.sendMessage(
            jid,
            {
              text:
                `❌ ${name} ɴᴏᴛ ғᴏᴜɴᴅ`
            },
            {
              quoted: message
            }
          )
        }

        env =
          env.replace(regex, '')

        fs.writeFileSync(
          envPath,
          env,
          'utf8'
        )

        delete process.env[name]

        return await sock.sendMessage(
          jid,
          {
            text:
              '✅ ᴠᴀʀɪᴀʙʟᴇ ᴅᴇʟᴇᴛᴇᴅ\n\n' +
              `🗑️ ɴᴀᴍᴇ: ${name}`
          },
          {
            quoted: message
          }
        )
      }

      /*
       * SET VAR
       */

      const name =
        args?.[0]
          ?.trim()
          .toUpperCase()

      const value =
        args
          ?.slice(1)
          .join(' ')
          .trim()

      if (!name || !value) {
        return await sock.sendMessage(
          jid,
          {
            text:
              '❌ ᴜsᴀɢᴇ\n\n' +
              '.sᴇᴛᴠᴀʀ <ɴᴀᴍᴇ> <ᴠᴀʟᴜᴇ>\n\n' +
              'ᴇxᴀᴍᴘʟᴇ:\n' +
              '.sᴇᴛᴠᴀʀ ᴘʀᴇғɪx !\n' +
              '.sᴇᴛᴠᴀʀ ᴍᴏᴅᴇ ᴘᴜʙʟɪᴄ'
          },
          {
            quoted: message
          }
        )
      }

      if (
        !/^[A-Z_$][A-Z0-9_$]*$/i.test(name)
      ) {
        return await sock.sendMessage(
          jid,
          {
            text:
              '❌ ɪɴᴠᴀʟɪᴅ ᴠᴀʀɪᴀʙʟᴇ ɴᴀᴍᴇ'
          },
          {
            quoted: message
          }
        )
      }

      const escapedValue =
        value
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\r?\n/g, '\\n')

      const line =
        `${name}="${escapedValue}"`

      const regex =
        new RegExp(
          `^\\s*${name}\\s*=.*(?:\\r?\\n|$)`,
          'gim'
        )

      if (regex.test(env)) {
        env =
          env.replace(
            regex,
            `${line}\n`
          )
      } else {
        if (
          env.length > 0 &&
          !env.endsWith('\n')
        ) {
          env += '\n'
        }

        env += `${line}\n`
      }

      fs.writeFileSync(
        envPath,
        env,
        'utf8'
      )

      process.env[name] = value

      return await sock.sendMessage(
        jid,
        {
          text:
            '✅ ᴠᴀʀɪᴀʙʟᴇ sᴇᴛ sᴜᴄᴄᴇssғᴜʟʟʏ\n\n' +
            `🔧 ɴᴀᴍᴇ: ${name}\n` +
            `📝 ᴠᴀʟᴜᴇ: ${
              name === 'HEROKU_API_KEY'
                ? '••••••••••••'
                : value
            }\n\n` +
            '♻️ ᴘʀᴏᴄᴇss.ᴇɴᴠ ᴜᴘᴅᴀᴛᴇᴅ'
        },
        {
          quoted: message
        }
      )

    } catch (error) {
      console.error(
        '[SETVAR] Error:',
        error?.message || error
      )

      return await sock.sendMessage(
        jid,
        {
          text:
            '❌ ᴠᴀʀ ᴏᴘᴇʀᴀᴛɪᴏɴ ғᴀɪʟᴇᴅ\n\n' +
            `${error?.message || error}`
        },
        {
          quoted: message
        }
      )
    }
  }
}
