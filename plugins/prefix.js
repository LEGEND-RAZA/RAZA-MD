import { getDb, saveDb } from '../database/index.js'

const DB_KEY = 'prefix.json'

function toSmallCaps(text) {
  const map = {
    a: '\u1D00', b: '\u0299', c: '\u1D04', d: '\u1D05', e: '\u1D07',
    f: '\u0493', g: '\u0262', h: '\u029C', i: '\u026A', j: '\u1D0A',
    k: '\u1D0B', l: '\u029F', m: '\u1D0D', n: '\u0274', o: '\u1D0F',
    p: '\u1D18', q: '\u01FA', r: '\u0280', s: 's',      t: '\u1D1B',
    u: '\u1D1C', v: '\u1D20', w: '\u1D21', x: 'x',      y: '\u028F',
    z: '\u1D22'
  }
  return String(text || '').toLowerCase().split('').map((c) => map[c] || c).join('')
}

export default {
  command: 'prefix',
  description: 'Change or check the bot command prefix',
  async run({ sock, message, args, isOwner }) {
    const jid = message.key.remoteJid

    if (!isOwner) {
      return await sock.sendMessage(
        jid,
        { text: `❌ ${toSmallCaps('only the bot owner can change the prefix.')}` },
        { quoted: message }
      )
    }

    const db = getDb(DB_KEY, { prefix: '!' })
    const newPrefix = args[0]?.trim()

    if (!newPrefix) {
      return await sock.sendMessage(
        jid,
        {
          text:
            `⚙️ *${toSmallCaps('current prefix')}:* [ ${db.prefix} ]\n\n` +
            `*${toSmallCaps('usage')}:* !prefix <new_prefix>`
        },
        { quoted: message }
      )
    }

    db.prefix = newPrefix
    saveDb(DB_KEY, db)

    await sock.sendMessage(
      jid,
      { text: `✅ *${toSmallCaps('prefix successfully updated to')}* [ ${newPrefix} ]` },
      { quoted: message }
    )
  }
}