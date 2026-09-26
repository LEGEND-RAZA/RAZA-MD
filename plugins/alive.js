import os from 'node:os'

function toSmallCaps(text) {
  const map = {
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
    .map((c) => map[c] || c)
    .join('')
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / (3600 * 24))
  const h = Math.floor((seconds % (3600 * 24)) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)

  const parts = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0) parts.push(`${h}h`)
  if (m > 0) parts.push(`${m}m`)
  parts.push(`${s}s`)

  return parts.join(' ')
}

export default {
  command: 'alive',
  description: 'Check if the bot is online and view system info',

  async run({ sock, message }) {
    const jid = message.key.remoteJid
    const uptime = formatUptime(process.uptime())
    const ramUsage = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)
    const totalRam = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2)

    const text =
      `🤖 *${toSmallCaps('bot is active')}*\n\n` +
      `• *${toSmallCaps('status')}:* ${toSmallCaps('online and operational')}\n` +
      `• *${toSmallCaps('uptime')}:* ${uptime}\n` +
      `• *${toSmallCaps('ram usage')}:* ${ramUsage} MB / ${totalRam} GB\n` +
      `• *${toSmallCaps('platform')}:* ${os.platform()}\n\n` +
      `✨ *${toSmallCaps('type !menu to see available commands.')}*`

    await sock.sendMessage(jid, { text }, { quoted: message })
  }
}