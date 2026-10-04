import fs from 'node:fs'
import path from 'node:path'

function toSmallCaps(text) {
  const map = {
    a: '\u1D00', b: '\u0299', c: '\u1D04', d: '\u1D05', e: '\u1D07',
    f: '\u0493', g: '\u0262', h: '\u029C', i: '\u026A', j: '\u1D0A',
    k: '\u1D0B', l: '\u029F', m: '\u1D0D', n: '\u0274', o: '\u1D0F',
    p: '\u1D18', q: '\u01FA', r: '\u0280', s: 's', t: '\u1D1B',
    u: '\u1D1C', v: '\u1D20', w: '\u1D21', x: 'x', y: '\u028F',
    z: '\u1D22'
  }

  return String(text || '')
    .toLowerCase()
    .split('')
    .map(c => map[c] || c)
    .join('')
}

export default {
  command: 'prefix',
  category: 'owner',
  description: 'Change or check the bot command prefix',

  async run({
    sock,
    message,
    args,
    isOwner
  }) {
    const jid =
      message?.key?.remoteJid

    if (!jid) return

    if (!isOwner) {
      return await sock.sendMessage(
        jid,
        {
          text:
            `❌ ${toSmallCaps(
              'only the bot owner can change the prefix.'
            )}`
        },
        {
          quoted: message
        }
      )
    }

    const currentPrefix =
      process.env.PREFIX || '.'

    const newPrefix =
      args?.[0]?.trim()

    if (!newPrefix) {
      return await sock.sendMessage(
        jid,
        {
          text:
            `⚙️ *${toSmallCaps(
              'current prefix'
            )}:* [ ${currentPrefix} ]\n\n` +
            `*${toSmallCaps(
              'usage'
            )}:* ${currentPrefix}prefix <new_prefix>`
        },
        {
          quoted: message
        }
      )
    }

    const envPath =
      path.join(
        process.cwd(),
        '.env'
      )

    try {
      let env =
        fs.existsSync(envPath)
          ? fs.readFileSync(
              envPath,
              'utf8'
            )
          : ''

      const regex =
        /^PREFIX\s*=.*(?:\r?\n|$)/im

      const newLine =
        `PREFIX="${newPrefix.replace(
          /\\/g,
          '\\\\'
        ).replace(
          /"/g,
          '\\"'
        )}"\n`

      if (regex.test(env)) {
        env =
          env.replace(
            regex,
            newLine
          )
      } else {
        if (
          env.length > 0 &&
          !env.endsWith('\n')
        ) {
          env += '\n'
        }

        env += newLine
      }

      fs.writeFileSync(
        envPath,
        env,
        'utf8'
      )

      process.env.PREFIX =
        newPrefix

      return await sock.sendMessage(
        jid,
        {
          text:
            `✅ *${toSmallCaps(
              'prefix successfully updated to'
            )}* [ ${newPrefix} ]\n\n` +
            `♻️ ${toSmallCaps(
              'environment variable updated'
            )}`
        },
        {
          quoted: message
        }
      )

    } catch (error) {
      console.error(
        '[PREFIX] Error:',
        error?.message || error
      )

      return await sock.sendMessage(
        jid,
        {
          text:
            `❌ ${toSmallCaps(
              'failed to update prefix'
            )}\n\n` +
            `${error?.message || error}`
        },
        {
          quoted: message
        }
      )
    }
  }
}
