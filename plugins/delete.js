export default {
  command: ['delete', 'del', 'dlt'],
  category: 'group',

  async run({ sock, message, isGroup, isOwner }) {
    const jid = message?.key?.remoteJid
    if (!jid) return

    const contextInfo =
      message?.message?.extendedTextMessage?.contextInfo ||
      message?.message?.imageMessage?.contextInfo ||
      message?.message?.videoMessage?.contextInfo ||
      message?.message?.audioMessage?.contextInfo ||
      message?.message?.documentMessage?.contextInfo

    const stanzaId = contextInfo?.stanzaId
    const participant =
      contextInfo?.participant ||
      contextInfo?.remoteJid

    if (!stanzaId) return

    try {
      if (isGroup) {
        const metadata = await sock.groupMetadata(jid).catch(() => null)
        if (!metadata) return

        const sender =
          message?.key?.participant ||
          message?.participant ||
          jid

        const senderNormalized = sender.split(':')[0]

        const isAdmin = metadata.participants.some(p => {
          const participantId = p?.id?.split(':')[0]
          return (
            participantId === senderNormalized &&
            (p.admin === 'admin' || p.admin === 'superadmin')
          )
        })

        if (!isAdmin && !isOwner) return
      }

      const botJid = sock?.user?.id
        ? sock.user.id.split(':')[0] + '@s.whatsapp.net'
        : null

      const targetJid = participant || jid

      await sock.sendMessage(jid, {
        delete: {
          remoteJid: jid,
          fromMe: botJid ? targetJid === botJid : false,
          id: stanzaId,
          participant: targetJid
        }
      })
    } catch (error) {
      console.error('[DELETE] Error:', error?.message || error)
    }
  }
}
