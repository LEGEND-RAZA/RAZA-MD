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

function formatCategory(category) {
  const text = String(category || 'other')
  if (!text) return 'ᴏther'

  const first = text.charAt(0)
  const rest = text.slice(1)

  const boldSerif = {
    a: '𝐀',
    b: '𝐁',
    c: '𝐂',
    d: '𝐃',
    e: '𝐄',
    f: '𝐅',
    g: '𝐆',
    h: '𝐇',
    i: '𝐈',
    j: '𝐉',
    k: '𝐊',
    l: '𝐋',
    m: '𝐌',
    n: '𝐍',
    o: '𝐎',
    p: '𝐏',
    q: '𝐐',
    r: '𝐑',
    s: '𝐒',
    t: '𝐓',
    u: '𝐔',
    v: '𝐕',
    w: '𝐖',
    x: '𝐗',
    y: '𝐘',
    z: '𝐙'
  }

  return (
    boldSerif[first.toLowerCase()] || first
  ) + rest
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
      `╭━━━〔 𝐑ᴀᴢᴀ 𝐌ᴅ 𝐁ᴏᴛ 〕━━━┈⊷\n` +
      `│\n` +
      `│ ${toSmallCaps('menu')}\n` +
      `│ ${toSmallCaps('total commands')}: ${seenCommands.size}\n` +
      `│\n` +
      `╰━━━━━━━━━━━━━━━━━━━┈⊷\n\n`

    if (!categories.size) {
      menuText +=
        `╭─❒ ${formatCategory('other')} ❒\n` +
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
          `╭─❒ ${formatCategory(
            toSmallCaps(category)
          )} ❒\n` +
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
