// Clean Unicode Escape Map for Small Caps
function toSmallCaps(text) {
  const map = {
    a: '\u1D00', b: '\u0299', c: '\u1D04', d: '\u1D05', e: '\u1D07',
    f: '\u0493', g: '\u0262', h: '\u029C', i: '\u026A', j: '\u1D0A',
    k: '\u1D0B', l: '\u029F', m: '\u1D0D', n: '\u0274', o: '\u1D0F',
    p: '\u1D18', q: '\u01FA', r: '\u0280', s: 's',      t: '\u1D1B',
    u: '\u1D1C', v: '\u1D20', w: '\u1D21', x: 'x',      y: '\u028F',
    z: '\u1D22'
  }
  return String(text || '')
    .toLowerCase()
    .split('')
    .map((c) => map[c] || c)
    .join('')
}

export default {
  command: 'owner',
  description: 'Get bot owner contact details',
  async run({ sock, message }) {
    const jid = message.key.remoteJid
    const owner1 = '923280966780'
    const owner2 = '923197135780'
    const ownerName = '𝐋ᴇɢᴇɴᴅ 𝐑ᴀᴢᴀ'

    const vcard1 =
      'BEGIN:VCARD\n' +
      'VERSION:3.0\n' +
      `FN:${ownerName}\n` +
      `ORG:${toSmallCaps('bot developer')};\n` +
      `TEL;type=CELL;type=VOICE;waid=${owner1}:+${owner1}\n` +
      'END:VCARD'

    const vcard2 =
      'BEGIN:VCARD\n' +
      'VERSION:3.0\n' +
      `FN:${ownerName}\n` +
      `ORG:${toSmallCaps('bot developer')};\n` +
      `TEL;type=CELL;type=VOICE;waid=${owner2}:+${owner2}\n` +
      'END:VCARD'

    await sock.sendMessage(
      jid,
      {
        contacts: {
          displayName: ownerName,
          contacts: [{ vcard: vcard1 }, { vcard: vcard2 }]
        }
      },
      { quoted: message }
    )

    await sock.sendMessage(
      jid,
      {
        text:
          `👤 *${toSmallCaps('bot owner')}:* ${ownerName}\n` +
          `📞 *${toSmallCaps('primary')}:* +${owner1}\n` +
          `📞 *${toSmallCaps('secondary')}:* +${owner2}`
      },
      { quoted: message }
    )
  }
}