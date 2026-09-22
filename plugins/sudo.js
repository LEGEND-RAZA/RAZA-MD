import { getDb, saveDb } from '../database/index.js'

const DB_KEY = 'sudo.json'

function toSmallCaps(text) {
  const smallCapsMap = {
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
    .map((char) => smallCapsMap[char] || char)
    .join('')
}

export default {
  command: ['sudo', 'setsudo', 'delsudo', 'getsudo'],
  description: 'Manage dynamic sudo users',
  async run({ sock, message, args, command, isOwner }) {
    if (!isOwner) return

    const jid = message.key.remoteJid
    const data = getDb(DB_KEY, { sudoNumbers: [] })

    // Determine sub-action based on command or first argument
    let subCmd = command
    let targetArg = args[0]

    if (command === 'sudo') {
      subCmd = args[0]?.toLowerCase()
      targetArg = args[1]
    }

    // Extract target number from argument or quoted message
    let target = targetArg ? targetArg.replace(/\D/g, '') : ''
    if (!target && message.message?.extendedTextMessage?.contextInfo?.participant) {
      target = message.message.extendedTextMessage.contextInfo.participant.split('@')[0].replace(/\D/g, '')
    }

    // --- ADD / SET SUDO ---
    if (subCmd === 'setsudo' || subCmd === 'add' || subCmd === 'set') {
      if (!target) {
        return await sock.sendMessage(jid, { text: `❌ ${toSmallCaps('please provide a phone number or reply to a message')}` }, { quoted: message })
      }
      if (!data.sudoNumbers.includes(target)) {
        data.sudoNumbers.push(target)
        saveDb(DB_KEY, data)
      }
      return await sock.sendMessage(
        jid,
        { text: `✅ ${toSmallCaps('added sudo user')}: @${target}`, mentions: [`${target}@s.whatsapp.net`] },
        { quoted: message }
      )
    }

    // --- REMOVE / DEL SUDO ---
    if (subCmd === 'delsudo' || subCmd === 'del' || subCmd === 'remove') {
      if (!target) {
        return await sock.sendMessage(jid, { text: `❌ ${toSmallCaps('please provide a phone number or reply to a message')}` }, { quoted: message })
      }
      data.sudoNumbers = data.sudoNumbers.filter((n) => n !== target)
      saveDb(DB_KEY, data)
      return await sock.sendMessage(
        jid,
        { text: `❌ ${toSmallCaps('removed sudo user')}: @${target}`, mentions: [`${target}@s.whatsapp.net`] },
        { quoted: message }
      )
    }

    // --- LIST / GET SUDO ---
    if (subCmd === 'getsudo' || subCmd === 'list') {
      const listText = data.sudoNumbers.length
        ? `📋 *${toSmallCaps('sudo users list')}:*\n\n` + data.sudoNumbers.map((n) => `• @${n}`).join('\n')
        : `❌ ${toSmallCaps('no sudo users found')}`

      return await sock.sendMessage(
        jid,
        { text: listText, mentions: data.sudoNumbers.map((n) => `${n}@s.whatsapp.net`) },
        { quoted: message }
      )
    }

    // --- HELP MENU ---
    const helpText = `📌 *${toSmallCaps('raza sudo manager')}*

• *!setsudo <number/reply>* - ${toSmallCaps('add sudo user')}
• *!delsudo <number/reply>* - ${toSmallCaps('remove sudo user')}
• *!getsudo* - ${toSmallCaps('list all sudo users')}`

    return await sock.sendMessage(jid, { text: helpText }, { quoted: message })
  }
}