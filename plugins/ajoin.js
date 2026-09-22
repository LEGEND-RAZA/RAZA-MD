import { getDb, saveDb } from '../database/index.js'

const DB_KEY = 'ajoin.json'
const DEFAULT_DATA = { targetJids: [], enabled: false, mode: 'specific' }

// Convert text to Small Caps font
function toSmallCaps(text) {
  const smallCapsMap = {
    a: '\u1D00', b: '\u0299', c: '\u1D04', d: '\u1D05', e: '\u1D07',
    f: '\u0493', g: '\u0262', h: '\u029C', i: '\u026A', j: '\u1D0A',
    k: '\u1D0B', l: '\u029F', m: '\u1D0D', n: '\u0274', o: '\u1D0F',
    p: '\u1D18', q: 'q', r: '\u0280', s: 's', t: '\u1D1B',
    u: '\u1D1C', v: '\u1D20', w: '\u1D21', x: 'x', y: '\u028F',
    z: '\u1D22'
  }

  return String(text || '')
    .toLowerCase()
    .split('')
    .map((char) => smallCapsMap[char] || char)
    .join('')
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

export default {
  command: ['ajoin'],
  description: 'AutoJoin control system for WhatsApp group invites',
  category: 'tools',

  async run({ sock, message, args, isOwner }) {
    if (!isOwner) return

    const data = getDb(DB_KEY, DEFAULT_DATA)
    const jid = message.key.remoteJid
    const cmd = args[0]?.toLowerCase()
    const value = args.slice(1).join(' ').trim()

    if (!cmd || cmd === 'list') {
      const listText = data.targetJids.length
        ? `📋 *${toSmallCaps('target jids')}:*\n\n${data.targetJids.join('\n')}`
        : `❌ ${toSmallCaps('no target jids added')}`

      return await sock.sendMessage(
        jid,
        { text: listText },
        { quoted: message }
      )
    }

    if (cmd === 'add') {
      if (!value) {
        return await sock.sendMessage(
          jid,
          { text: `❌ ${toSmallCaps('please provide a jid')}` },
          { quoted: message }
        )
      }

      if (!data.targetJids.includes(value)) {
        data.targetJids.push(value)
        saveDb(DB_KEY, data)
      }

      return await sock.sendMessage(
        jid,
        { text: `✅ ${toSmallCaps('jid added')}` },
        { quoted: message }
      )
    }

    if (cmd === 'del' || cmd === 'remove') {
      if (!value) {
        return await sock.sendMessage(
          jid,
          { text: `❌ ${toSmallCaps('please provide a jid')}` },
          { quoted: message }
        )
      }

      data.targetJids = data.targetJids.filter((j) => j !== value)
      saveDb(DB_KEY, data)

      return await sock.sendMessage(
        jid,
        { text: `❌ ${toSmallCaps('jid removed')}` },
        { quoted: message }
      )
    }

    if (cmd === 'on' && value !== 'all') {
      data.enabled = true
      data.mode = 'specific'
      saveDb(DB_KEY, data)

      return await sock.sendMessage(
        jid,
        { text: `✅ ${toSmallCaps('autojoin enabled specific jids')}` },
        { quoted: message }
      )
    }

    if (cmd === 'on' && value === 'all') {
      data.enabled = true
      data.mode = 'all'
      saveDb(DB_KEY, data)

      return await sock.sendMessage(
        jid,
        { text: `✅ ${toSmallCaps('autojoin enabled all chats')}` },
        { quoted: message }
      )
    }

    if (cmd === 'off') {
      data.enabled = false
      saveDb(DB_KEY, data)

      return await sock.sendMessage(
        jid,
        { text: `❌ ${toSmallCaps('autojoin disabled')}` },
        { quoted: message }
      )
    }

    const helpText = `📌 *${toSmallCaps('raza autojoin control')}*

• *!ajoin add <jid>* - ${toSmallCaps('add allowed jid')}
• *!ajoin del <jid>* - ${toSmallCaps('remove allowed jid')}
• *!ajoin list* - ${toSmallCaps('view saved jids')}
• *!ajoin on* - ${toSmallCaps('enable for saved jids')}
• *!ajoin on all* - ${toSmallCaps('enable for all chats')}
• *!ajoin off* - ${toSmallCaps('disable autojoin')}

${toSmallCaps('status')}: ${data.enabled ? '✅ ON' : '❌ OFF'} | ${toSmallCaps('mode')}: ${data.mode === 'all' ? toSmallCaps('all chats') : toSmallCaps('specific jids')}`

    return await sock.sendMessage(
      jid,
      { text: helpText },
      { quoted: message }
    )
  },

  // Passive message listener hook for auto-joining group links
  async on({ sock, message, text }) {
    try {
      if (!message || !message.message || message.key.fromMe) return

      const data = getDb(DB_KEY, DEFAULT_DATA)
      if (!data.enabled) return

      const remoteJid = message.key.remoteJid
      const sender = message.key.participant || remoteJid

      if (data.mode === 'specific') {
        const isAllowedSender =
          data.targetJids.includes(sender) ||
          data.targetJids.includes(remoteJid)

        if (!isAllowedSender) return
      }

      const match = text.match(
        /chat\.whatsapp\.com\/([0-9A-Za-z]{20,26})/i
      )

      if (!match) return

      const inviteCode = match[1]

      await delay(1000)

      try {
        await sock.groupAcceptInvite(inviteCode)

        await sock.sendMessage(remoteJid, {
          react: {
            text: '✅',
            key: message.key
          }
        })
      } catch (e) {
        const err = String(e?.message || e).toLowerCase()

        if (err.includes('already') || err.includes('409')) {
          await sock.sendMessage(remoteJid, {
            react: {
              text: '⚠️',
              key: message.key
            }
          })
        } else {
          await sock.sendMessage(remoteJid, {
            react: {
              text: '❌',
              key: message.key
            }
          })
        }
      }
    } catch (err) {
      console.error('[AutoJoin Exception]:', err)
    }
  }
}

If you send the other plugins, I can fix the same Chrome/UTF-8 font and emoji corruption in them while keeping their functionality unchanged.