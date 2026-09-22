export default {
  command: 'ping',
  description: 'Check bot latency and response time',
  async run({ sock, message }) {
    const start = Date.now()
    const jid = message.key.remoteJid

    // Send initial message
    const sent = await sock.sendMessage(
      jid,
      { text: '🏓 𝐏ɪɴɢɪɴɢ...' },
      { quoted: message }
    )

    const ms = Date.now() - start

    // Edit the same message with the calculated speed
    await sock.sendMessage(jid, {
      text: `🏓 𝐏ᴏɴɢ!\n⚡ ${ms} ms`,
      edit: sent.key
    })
  }
}