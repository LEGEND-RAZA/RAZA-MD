export default {
  command: ['jid'],
  async run({ sock, message, args }) {
    const chatJid = message.key.remoteJid

    // Check if a user was tagged or replied to
    let targetUser = message.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
                     message.message?.extendedTextMessage?.contextInfo?.participant

    if (!targetUser && args[0]) {
      targetUser = args[0].replace(/\D/g, '') + '@s.whatsapp.net'
    }

    const outputJid = targetUser || chatJid

    await sock.sendMessage(chatJid, {
      text: outputJid
    }, { quoted: message })
  }
}