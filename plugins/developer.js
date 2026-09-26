import fs from 'node:fs'
import path from 'node:path'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

import {
  plugins,
  loadPlugins
} from '../lib/plugin-loader.js'

const execAsync =
  promisify(exec)

const PLUGIN_DIR =
  path.join(
    process.cwd(),
    'plugins'
  )

export default {
  command: [
    'plugin',
    'plugins',
    'reload',
    'exec',
    'update'
  ],

  description:
    'Developer tools',

  async run({
    sock,
    message,
    args,
    command,
    isOwner
  }) {

    if (!isOwner) {
      return await sock.sendMessage(
        message.key.remoteJid,
        {
          text:
            '❌ 𝐎ɴʟʏ 𝐎ᴡɴᴇʀ 𝐂ᴀɴ 𝐔sᴇ 𝐃ᴇᴠᴇʟᴏᴘᴇʀ 𝐂ᴏᴍᴍᴀɴᴅs'
        },
        {
          quoted: message
        }
      )
    }

    const jid =
      message.key.remoteJid

    if (command === 'plugins') {
      const files =
        fs
          .readdirSync(PLUGIN_DIR)
          .filter(
            (file) =>
              file.endsWith('.js')
          )

      if (!files.length) {
        return await sock.sendMessage(
          jid,
          {
            text:
              '📂 𝐍ᴏ 𝐏ʟᴜɢɪɴs 𝐅ᴏᴜɴᴅ'
          },
          {
            quoted: message
          }
        )
      }

      const uniquePlugins =
        new Map()

      for (
        const plugin of plugins.values()
      ) {
        if (
          plugin?.__file
        ) {
          uniquePlugins.set(
            plugin.__file,
            plugin
          )
        }
      }

      const list =
        files
          .map(
            (file, index) => {
              const plugin =
                uniquePlugins.get(
                  file
                )

              const commands =
                plugin?.command
                  ? Array.isArray(
                      plugin.command
                    )
                    ? plugin.command
                    : [plugin.command]
                  : []

              return (
                `${index + 1}. ${file}` +
                (
                  commands.length
                    ? `\n   └─ ${commands
                        .map(
                          (x) =>
                            `.${x}`
                        )
                        .join(', ')}`
                    : ''
                )
              )
            }
          )
          .join('\n')

      return await sock.sendMessage(
        jid,
        {
          text:
            `╭━━━〔 𝐏ʟᴜɢɪɴ 𝐋ɪsᴛ 〕━━━┈⊷\n` +
            `┃ 𝐓ᴏᴛᴀʟ : ${files.length}\n` +
            `╰━━━━━━━━━━━━━━━━━━━━┈⊷\n\n` +
            list
        },
        {
          quoted: message
        }
      )
    }

    if (command === 'plugin') {
      const input =
        args
          ?.join(' ')
          ?.trim()

      if (!input) {
        return await sock.sendMessage(
          jid,
          {
            text:
              '❌ 𝐔sᴀɢᴇ:\n\n' +
              '➤ .plugin <name>\n' +
              '➤ .plugin <gist-url>'
          },
          {
            quoted: message
          }
        )
      }

      const isGist =
        /^https:\/\/gist\.github\.com\//i.test(
          input
        ) ||
        /^https:\/\/gist\.githubusercontent\.com\//i.test(
          input
        )

      if (isGist) {
        try {
          let rawUrl =
            input

          if (
            /^https:\/\/gist\.github\.com\//i.test(
              input
            )
          ) {
            const cleanUrl =
              input
                .split('?')[0]
                .replace(/\/+$/, '')

            const parts =
              cleanUrl.split('/')

            const username =
              parts[3]

            const gistId =
              parts[4]

            if (
              !username ||
              !gistId
            ) {
              throw new Error(
                'Invalid GitHub Gist URL'
              )
            }

            rawUrl =
              `https://gist.githubusercontent.com/${username}/${gistId}/raw`
          }

          const response =
            await fetch(
              rawUrl,
              {
                redirect: 'follow'
              }
            )

          if (!response.ok) {
            throw new Error(
              `HTTP ${response.status}`
            )
          }

          const code =
            await response.text()

          if (
            !code.trim()
          ) {
            throw new Error(
              'Gist is empty'
            )
          }

          if (
            code.length >
            100000
          ) {
            throw new Error(
              'Plugin is too large'
            )
          }

          if (
            !code.includes(
              'export default'
            ) &&
            !code.includes(
              'export const'
            ) &&
            !code.includes(
              'export async'
            )
          ) {
            throw new Error(
              'Invalid plugin export'
            )
          }

          fs.mkdirSync(
            PLUGIN_DIR,
            {
              recursive: true
            }
          )

          let filename =
            `plugin-${Date.now()}.js`

          try {
            const urlObj =
              new URL(
                rawUrl
              )

            const pathname =
              urlObj.pathname

            const last =
              pathname
                .split('/')
                .filter(Boolean)
                .pop()

            if (
              last &&
              last.endsWith('.js')
            ) {
              filename =
                path.basename(
                  last
                )
            }
          } catch {}

          if (
            !filename.endsWith(
              '.js'
            )
          ) {
            filename += '.js'
          }

          const filePath =
            path.join(
              PLUGIN_DIR,
              filename
            )

          fs.writeFileSync(
            filePath,
            code,
            'utf8'
          )

          let result

          try {
            result =
              await loadPlugins()
          } catch (error) {
            try {
              fs.unlinkSync(
                filePath
              )
            } catch {}

            await loadPlugins()

            throw new Error(
              `Plugin load failed: ${
                error?.message ||
                error
              }`
            )
          }

          const loaded =
            [...plugins.values()]
              .some(
                (plugin) =>
                  plugin?.__file ===
                  filename
              )

          if (!loaded) {
            return await sock.sendMessage(
              jid,
              {
                text:
                  `⚠️ 𝐏ʟᴜɢɪɴ 𝐒ᴀᴠᴇᴅ\n\n` +
                  `𝐅ɪʟᴇ : ${filename}\n` +
                  `𝐁ᴜᴛ 𝐍ᴏ 𝐕ᴀʟɪᴅ 𝐂ᴏᴍᴍᴀɴᴅ 𝐖ᴀs 𝐑ᴇɢɪsᴛᴇʀᴇᴅ`
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
                `╭━━━〔 𝐏ʟᴜɢɪɴ 𝐀ᴅᴅᴇᴅ 〕━━━┈⊷\n` +
                `┃\n` +
                `┃ 𝐅ɪʟᴇ : ${filename}\n` +
                `┃ 𝐂ᴏᴍᴍᴀɴᴅs : ${result.commands}\n` +
                `┃\n` +
                `╰━━━━━━━━━━━━━━━━━━━━┈⊷\n\n` +
                `✅ 𝐏ʟᴜɢɪɴ 𝐋ᴏᴀᴅᴇᴅ 𝐒ᴜᴄᴄᴇssғᴜʟʟʏ`
            },
            {
              quoted: message
            }
          )

        } catch (error) {
          return await sock.sendMessage(
            jid,
            {
              text:
                `❌ 𝐏ʟᴜɢɪɴ 𝐀ᴅᴅ 𝐅ᴀɪʟᴇᴅ\n\n${
                  error?.message ||
                  error
                }`
            },
            {
              quoted: message
            }
          )
        }
      }

      const cleanName =
        input
          .replace(
            /\.js$/i,
            ''
          )
          .toLowerCase()

      let plugin
      let file

      for (
        const [cmd, obj]
        of plugins
      ) {
        if (
          cmd === cleanName ||
          obj?.__file
            ?.replace(
              /\.js$/i,
              ''
            )
            .toLowerCase() ===
            cleanName
        ) {
          plugin = obj
          file = obj.__file
          break
        }
      }

      if (!plugin) {
        return await sock.sendMessage(
          jid,
          {
            text:
              `❌ 𝐏ʟᴜɢɪɴ 𝐍ᴏᴛ ғᴏᴜɴᴅ: ${input}`
          },
          {
            quoted: message
          }
        )
      }

      const commands =
        plugin.command
          ? Array.isArray(
              plugin.command
            )
            ? plugin.command
            : [plugin.command]
          : []

      const text =
        `╭━━━〔 𝐏ʟᴜɢɪɴ 𝐈ɴғᴏ 〕━━━┈⊷\n` +
        `┃ 𝐍ᴀᴍᴇ : ${file || input}\n` +
        `┃ 𝐓ʏᴘᴇ : ${plugin.type || 'command'}\n` +
        `┃ 𝐂ᴏᴍᴍᴀɴᴅs : ${
          commands.length
            ? commands
                .map(
                  (x) =>
                    `.${x}`
                )
                .join(', ')
            : 'None'
        }\n` +
        `┃ 𝐃ᴇsᴄʀɪᴘᴛɪᴏɴ : ${
          plugin.description ||
          'No description'
        }\n` +
        `╰━━━━━━━━━━━━━━━━━━━━┈⊷`

      return await sock.sendMessage(
        jid,
        {
          text
        },
        {
          quoted: message
        }
      )
    }

    if (command === 'reload') {
      await sock.sendMessage(
        jid,
        {
          text:
            '🔄 𝐑ᴇʟᴏᴀᴅɪɴɢ 𝐏ʟᴜɢɪɴs...'
        },
        {
          quoted: message
        }
      )

      try {
        const result =
          await loadPlugins()

        return await sock.sendMessage(
          jid,
          {
            text:
              `✅ 𝐏ʟᴜɢɪɴs 𝐑ᴇʟᴏᴀᴅᴇᴅ\n\n` +
              `𝐂ᴏᴍᴍᴀɴᴅs : ${result.commands}\n` +
              `𝐌ᴇssᴀɢᴇ 𝐋ɪsᴛᴇɴᴇʀs : ${result.messageListeners}\n` +
              `𝐆ʀᴏᴜᴘ 𝐋ɪsᴛᴇɴᴇʀs : ${result.groupListeners}`
          },
          {
            quoted: message
          }
        )

      } catch (error) {
        return await sock.sendMessage(
          jid,
          {
            text:
              `❌ 𝐑ᴇʟᴏᴀᴅ 𝐅ᴀɪʟᴇᴅ\n\n${error?.message || error}`
          },
          {
            quoted: message
          }
        )
      }
    }

    if (command === 'exec') {
      const code =
        args
          ?.join(' ')
          ?.trim()

      if (!code) {
        return await sock.sendMessage(
          jid,
          {
            text:
              '❌ 𝐔sᴀɢᴇ: .exec <command>'
          },
          {
            quoted: message
          }
        )
      }

      try {
        const {
          stdout,
          stderr
        } =
          await execAsync(
            code,
            {
              cwd: process.cwd(),
              timeout: 30000,
              maxBuffer:
                1024 * 1024
            }
          )

        const output =
          (
            stdout ||
            stderr ||
            'Command executed successfully.'
          )
            .trim()

        return await sock.sendMessage(
          jid,
          {
            text:
              `╭━━━〔 𝐄xᴇᴄ 〕━━━┈⊷\n` +
              `┃\n` +
              `┃ ${output.slice(0, 6000)}\n` +
              `┃\n` +
              `╰━━━━━━━━━━━━━━━━━━━━┈⊷`
          },
          {
            quoted: message
          }
        )

      } catch (error) {
        const output =
          (
            error?.stdout ||
            error?.stderr ||
            error?.message ||
            error
          )
            .toString()
            .trim()

        return await sock.sendMessage(
          jid,
          {
            text:
              `❌ 𝐄xᴇᴄ 𝐄ʀʀᴏʀ\n\n${output.slice(0, 6000)}`
          },
          {
            quoted: message
          }
        )
      }
    }

    if (command === 'update') {
      try {
        const {
          stdout
        } =
          await execAsync(
            'git pull --ff-only',
            {
              cwd: process.cwd(),
              timeout: 60000,
              maxBuffer:
                1024 * 1024
            }
          )

        await sock.sendMessage(
          jid,
          {
            text:
              `╭━━━〔 𝐔ᴘᴅᴀᴛᴇ 〕━━━┈⊷\n` +
              `┃\n` +
              `┃ ${(
                stdout ||
                'Already up to date.'
              ).trim().slice(0, 5000)}\n` +
              `┃\n` +
              `╰━━━━━━━━━━━━━━━━━━━━┈⊷\n\n` +
              `🔄 𝐑ᴇsᴛᴀʀᴛɪɴɢ...`
          },
          {
            quoted: message
          }
        )

        setTimeout(() => {
          process.exit(0)
        }, 1500)

      } catch (error) {
        return await sock.sendMessage(
          jid,
          {
            text:
              `❌ 𝐔ᴘᴅᴀᴛᴇ 𝐅ᴀɪʟᴇᴅ\n\n${
                error?.stderr ||
                error?.message ||
                error
              }`
          },
          {
            quoted: message
          }
        )
      }
    }
  }
}