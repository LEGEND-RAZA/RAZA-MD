export default {
  command: ['delete', 'del', 'dlt'],
  async run({ sock, message, isGroup, isOwner }) {
    const jid = message.key.remoteJid

    // Get context info of the quoted message
    const contextInfo = message.message?.extendedTextMessage?.contextInfo
    const quotedKey = contextInfo?.stanzaId

    if (!quotedKey) return

    const targetParticipant = contextInfo.participant || contextInfo.remoteJid

    // Admin & Owner authorization check for deleting other users' messages in groups
    if (isGroup) {
      const groupMetadata = await sock.groupMetadata(jid).catch(() => null)
      if (groupMetadata) {
        const sender = message.key.participant || jid
        const isAdmin = groupMetadata.participants.some(p => p.id === sender && p.admin !== null)
        
        // If not deleting own message, check admin/owner permissions
        if (targetParticipant !== message.key.id && !isAdmin && !isOwner) return
      }
    }

    try {
      await sock.sendMessage(jid, {
        delete: {
          remoteJid: jid,
          fromMe: targetParticipant === sock.user.id.split(':')[0] + '@s.whatsapp.net',
          id: quotedKey,
          participant: targetParticipant
        }
      })
    } catch (e) {
      console.error('Delete error:', e)
    }
  }
}