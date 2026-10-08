export default {
  command: ['fancy'],
  category: 'tools',

  async run({
    sock,
    message,
    args,
    quotedMessage,
    isOwner
  }) {
    if (!isOwner) return

    const jid =
      message?.key?.remoteJid

    if (!jid) return

    const argText =
      Array.isArray(args)
        ? args.join(' ')
        : String(args || '')

    let text = argText.trim()

    if (!text && quotedMessage) {
      text =
        quotedMessage.conversation ||
        quotedMessage.extendedTextMessage?.text ||
        quotedMessage.imageMessage?.caption ||
        quotedMessage.videoMessage?.caption ||
        quotedMessage.documentMessage?.caption ||
        ''
    }

    text = String(text || '').trim()

    if (!text) return

    const special = {
      e: 'ə̽',
      u: ['ʊ̊'],
      a: 'ʌ̄',
      n: 'η̽',
      y: 'ɣ',
      l: 'ɭ',
      t: 'ʈ',
      r: 'ɼ',
      f: 'ƒ',
      m: 'ϻ̽',
      o: '๏፝֟፝'
    }

    const smallcaps = {
      b: 'ʙ',
      c: 'ᴄ',
      d: 'ᴅ',
      g: 'ɢ',
      h: 'ⱶ֟ؖ꧊',
      i: 'ɪ',
      j: 'ᴊ',
      k: 'ᴋ',
      p: 'ᴘ',
      q: 'ǫ',
      s: 's',
      v: 'ᴠ',
      w: 'Ꮗ',
      x: 'x',
      z: 'ᴢ'
    }

    const bold = {
      A: '𝐀', B: '𝐁', C: '𝐂', D: '𝐃', E: '𝐄',
      F: '𝐅', G: '𝐆', H: '𝐇', I: '𝐈', J: '𝐉',
      K: '𝐊', L: '𝐋', M: '𝐌', N: '𝐍', O: '𝐎',
      P: '𝐏', Q: '𝐐', R: '𝐑', S: '𝐒', T: '𝐓',
      U: '𝐔', V: '𝐕', W: '𝐖', X: '𝐗', Y: '𝐘',
      Z: '𝐙'
    }

    const style2 = {
      A: '𝛥', B: '𝛣', C: '𝐶', D: '𝐷', E: '𝛯',
      F: '𝐹', G: '𝐺', H: '𝐻', I: '𝛪', J: '𝐽',
      K: '𝛫', L: '𝐿', M: '𝛭', N: '𝛮', O: '𝛳',
      P: '𝛲', Q: '𝑄', R: '𝛶', S: '𝑆', T: '𝛵',
      U: '𝑈', V: '𝛻', W: '𝑊', X: '𝛸', Y: '𝛹',
      Z: '𝛧'
    }

    const first = text
      .split(/(\s+)/)
      .map(word => {
        if (/^\s+$/.test(word)) return word

        return [...word]
          .map((char, index) => {
            const lower =
              char.toLowerCase()

            if (index === 0) {
              if (lower === 'y') return 'Ɣ'

              return (
                bold[
                  char.toUpperCase()
                ] || char
              )
            }

            if (special[lower]) {
              return Array.isArray(
                special[lower]
              )
                ? special[lower][
                    Math.floor(
                      Math.random() *
                      special[lower].length
                    )
                  ]
                : special[lower]
            }

            return (
              smallcaps[lower] ||
              char.toLowerCase()
            )
          })
          .join('')
      })
      .join('')

    const second = text
      .split(/(\s+)/)
      .map(word => {
        if (/^\s+$/.test(word)) return word

        return [...word]
          .map(char =>
            style2[
              char.toUpperCase()
            ] || char
          )
          .join('')
      })
      .join('')

    await sock.sendMessage(jid, {
      text:
        `𝀈᪳𝆺𝅥𝆬᷼𓄹𝅮𝅯${first} 💀🐍🔥〬⃝̥𝆺𝆭𝆬𝆭𝆬`
    })

    await sock.sendMessage(jid, {
      text:
        `𓆩֓⤹${second}⤸֓𓆪`
    })
  }
}
