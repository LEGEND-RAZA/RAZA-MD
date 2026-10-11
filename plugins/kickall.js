export default {
command: ['kall'],
category: 'group',
description: 'Kick all non-admin members',

async run({ sock, message, isOwner, isGroup }) {
if (!isOwner) return;

const jid = message?.key?.remoteJid;
if (!jid) return;

const send = async (text) =>
  sock.sendMessage(jid, { text }, { quoted: message });

if (!isGroup || !jid.endsWith('@g.us')) {
  return send(
    '❌ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ 𝐎ɴʟʏ 𝐖ᴏʀᴋs 𝐈ɴ 𝐆ʀᴏᴜᴘs'
  );
}

try {
  const group = await sock.groupMetadata(jid);
  const participants = group.participants || [];

  // Normalize device-qualified WhatsApp JIDs.
  const normalizeJid = (value) => {
    if (typeof value !== 'string' || !value) return null;

    const at = value.lastIndexOf('@');
    if (at < 0) return value;

    const user = value.slice(0, at).split(':')[0];
    const server = value.slice(at + 1);

    return user && server ? `${user}@${server}` : null;
  };

  // A bot may expose both a phone JID and a LID.
  const botIds = new Set(
    [
      sock.user?.id,
      sock.user?.lid,
      sock.user?.phoneNumber
    ]
      .map(normalizeJid)
      .filter(Boolean)
  );

  const botParticipant = participants.find((p) => {
    const participantIds = [
      p.id,
      p.lid,
      p.phoneNumber
    ]
      .map(normalizeJid)
      .filter(Boolean);

    return participantIds.some((id) => botIds.has(id));
  });

  if (!botParticipant) {
    console.error('[KALL] Bot participant not found', {
      botIds: [...botIds],
      participantIds: participants.map((p) => ({
        id: p.id,
        lid: p.lid,
        phoneNumber: p.phoneNumber,
        admin: p.admin
      }))
    });

    return send(
      '❌ 𝐂ᴏᴜʟᴅ 𝐍ᴏᴛ 𝐕ᴇʀɪғʏ 𝐁ᴏᴛ 𝐒ᴛᴀᴛᴜs\n\n' +
      'Refresh group metadata and check the bot JID.'
    );
  }

  const botIsAdmin =
    botParticipant.admin === 'admin' ||
    botParticipant.admin === 'superadmin';

  if (!botIsAdmin) {
    return send(
      '❌ 𝐁ᴏᴛ 𝐈s 𝐍ᴏᴛ 𝐀ɴ 𝐀ᴅᴍɪɴ\n\n' +
      '𝐏ʀᴏᴍᴏᴛᴇ 𝐌ᴇ 𝐓ᴏ 𝐀ᴅᴍɪɴ 𝐁ᴇғᴏʀᴇ 𝐔sɪɴɢ 𝐓ʜɪs 𝐂ᴏᴍᴍᴀɴᴅ.'
    );
  }

  const botParticipantIds = new Set(
    [botParticipant.id, botParticipant.lid, botParticipant.phoneNumber]
      .map(normalizeJid)
      .filter(Boolean)
  );

  const users = participants
    .filter((p) => {
      const isAdmin =
        p.admin === 'admin' ||
        p.admin === 'superadmin';

      const ids = [p.id, p.lid, p.phoneNumber]
        .map(normalizeJid)
        .filter(Boolean);

      const isBot = ids.some((id) =>
        botParticipantIds.has(id)
      );

      return !isAdmin && !isBot && p.id;
    })
    .map((p) => p.id);

  if (!users.length) {
    return send('❌ 𝐍ᴏ 𝐍ᴏɴ-𝐀ᴅᴍɪɴ 𝐌ᴇᴍʙᴇʀs 𝐓ᴏ 𝐊ɪᴄᴋ');
  }

  const results = await sock.groupParticipantsUpdate(
    jid,
    users,
    'remove'
  );

  const removed = results.filter(
    (r) => r.status === '200' || r.status === 200
  ).length;

  const failed = results.length - removed;

  return send(
    `✅ 𝐑ᴇᴍᴏᴠᴇᴅ: *${removed}* 𝐌ᴇᴍʙᴇʀs` +
    (failed ? `\n⚠️ 𝐅ᴀɪʟᴇᴅ: *${failed}*` : '')
  );
} catch (error) {
  console.error('[KALL] Error:', error);

  return send(
    `❌ 𝐊ɪᴄᴋ 𝐅ᴀɪʟᴇᴅ\n\n${error?.message || String(error)}`
  );
}

}
};
