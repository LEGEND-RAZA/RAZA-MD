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
  return String(text)
    .toLowerCase()
    .split('')
    .map((char) => smallCapsMap[char] || char)
    .join('')
}

export default {
  command: ['menu'],
  async run({ sock, message, plugins }) {
    const jid = message.key.remoteJid

    // Safe fallback if plugins is undefined
    const loadedCommands = plugins ? Array.from(plugins.keys()) : []
    const commandList =
      loadedCommands.length > 0
        ? loadedCommands.map((cmd) => `- ${toSmallCaps(cmd)}`).join('\n')
        : `- ${toSmallCaps('no commands found')}`

    const menuText = `*${toSmallCaps('raza bot menu')}*\n\n${commandList}`

    await sock.sendMessage(jid, { text: menuText }, { quoted: message })
  }
}