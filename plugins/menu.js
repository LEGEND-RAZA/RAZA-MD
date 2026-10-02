function toSmallCaps(text) {
  const smallCapsMap = {
    a: '\u1D00',
    b: '\u0299',
    c: '\u1D04',
    d: '\u1D05',
    e: '\u1D07',
    f: '\u0493',
    g: '\u0262',
    h: '\u029C',
    i: '\u026A',
    j: '\u1D0A',
    k: '\u1D0B',
    l: '\u029F',
    m: '\u1D0D',
    n: '\u0274',
    o: '\u1D0F',
    p: '\u1D18',
    q: '\u01FA',
    r: '\u0280',
    s: 's',
    t: '\u1D1B',
    u: '\u1D1C',
    v: '\u1D20',
    w: '\u1D21',
    x: 'x',
    y: '\u028F',
    z: '\u1D22'
  }

  return String(text || '')
    .toLowerCase()
    .split('')
    .map((char) => smallCapsMap[char] || char)
    .join('')
}

function getPluginCommands(plugin) {
  if (!plugin) return []

  const commands =
    Array.isArray(plugin.command)
      ? plugin.command
      : [plugin.command]

  return commands
    .filter(Boolean)
    .map(String)
    .filter(
      command =>
        !command.startsWith('__')
    )
}

export default {
  command: ['menu'],

  async run({
    sock,
    message,
    plugins
  }) {
    const jid =
      message?.key?.remoteJid

    if (!jid) return

    const categories = new Map()
    const seenCommands = new Set()

    if (plugins) {
      const pluginObjects =
        new Set(
          Array.from(
            plugins.values()
          )
        )

      for (const plugin of pluginObjects) {
        const commands =
          getPluginCommands(plugin)

        if (!commands.length) continue

        const category =
          String(
            plugin.category || 'other'
          ).trim()

        if (!categories.has(category)) {
          categories.set(
            category,
            new Set()
          )
        }

        for (const command of commands) {
          if (
            seenCommands.has(command)
          ) {
            continue
          }

          seenCommands.add(command)

          categories
            .get(category)
            .add(command)
        }
      }
    }

    let menuText =
      `╭━━━〔 ʀᴀᴢᴀ ʙᴏᴛ 〕━━━┈⊷\n` +
      `│\n` +
      `│ ${toSmallCaps('menu')}\n` +
      `│ ${toSmallCaps('total commands')}: ${seenCommands.size}\n` +
      `│\n` +
      `╰━━━━━━━━━━━━━━━━━━━┈⊷\n\n`

    if (!categories.size) {
      menuText +=
        `╭─❒ ᴏᴛʜᴇʀ ❒\n` +
        `│  • ${toSmallCaps('no commands found')}\n` +
        `╰──────────────`
    } else {
      const sections = []

      for (
        const [category, commands]
        of categories
      ) {
        const commandList =
          Array.from(commands)
            .sort()
            .map(
              command =>
                `│  • ${toSmallCaps(command)}`
            )
            .join('\n')

        sections.push(
          `╭─❒ ${toSmallCaps(category)} ❒\n` +
          `${commandList}\n` +
          `╰──────────────`
        )
      }

      menuText +=
        sections.join('\n\n')
    }

    await sock.sendMessage(
      jid,
      {
        text: menuText
      },
      {
        quoted: message
      }
    )
  }
}