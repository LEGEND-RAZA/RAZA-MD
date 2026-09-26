import { getDb, saveDb } from '../database/index.js'

const DB_FILE = 'antigroupstatus.json'

const DEFAULT_DB = {
  groups: {},
  warnings: {}
}


/* =========================================
   DATABASE
========================================= */

function getDatabase() {
  return getDb(DB_FILE, DEFAULT_DB)
}

function saveDatabase(db) {
  saveDb(DB_FILE, db)
}

function normalizeNumber(jid) {
  return String(jid || '')
    .split('@')[0]
    .split(':')[0]
    .replace(/\D/g, '')
}

function getMode(db, jid) {
  return db.groups?.[jid] || false
}

function setMode(db, jid, mode) {
  if (!db.groups) {
    db.groups = {}
  }

  if (mode === false) {
    delete db.groups[jid]
  } else {
    db.groups[jid] = mode
  }

  saveDatabase(db)
}


/* =========================================
   VIOLATION COUNTER
========================================= */

function violationKey(jid, sender) {
  return `${jid}:${normalizeNumber(sender)}`
}

function addViolation(db, jid, sender) {
  if (!db.warnings) {
    db.warnings = {}
  }

  const key =
    violationKey(jid, sender)

  db.warnings[key] =
    (db.warnings[key] || 0) + 1

  saveDatabase(db)

  return db.warnings[key]
}

function resetViolation(db, jid, sender) {
  if (!db.warnings) {
    db.warnings = {}
  }

  delete db.warnings[
    violationKey(jid, sender)
  ]

  saveDatabase(db)
}


/* =========================================
   FIND PARTICIPANT
========================================= */

async function getParticipant(
  sock,
  jid,
  sender
) {
  try {

    const metadata =
      await sock.groupMetadata(jid)

    const senderNumber =
      normalizeNumber(sender)

    const participant =
      metadata.participants.find((p) => {

        const idNumber =
          normalizeNumber(p.id)

        const lidNumber =
          normalizeNumber(p.lid)

        return (
          (
            idNumber &&
            idNumber === senderNumber
          ) ||
          (
            lidNumber &&
            lidNumber === senderNumber
          )
        )
      })

    return participant || null

  } catch (error) {

    console.error(
      '[AntiGroupStatus] Metadata error:',
      error?.message || error
    )

    return null
  }
}


/* =========================================
   ADMIN CHECK
========================================= */

async function isAdmin(
  sock,
  jid,
  sender
) {
  const participant =
    await getParticipant(
      sock,
      jid,
      sender
    )

  if (!participant) {
    return false
  }

  return (
    participant.admin === 'admin' ||
    participant.admin === 'superadmin'
  )
}


/* =========================================
   RESOLVE KICK JID
========================================= */

async function getKickJid(
  sock,
  jid,
  sender
) {
  const participant =
    await getParticipant(
      sock,
      jid,
      sender
    )

  if (!participant) {
    console.error(
      `[AntiGroupStatus] Participant not found: ${sender}`
    )

    return null
  }

  /*
   * groupParticipantsUpdate needs
   * the actual participant ID.
   */
  return participant.id || null
}


/* =========================================
   DELETE STATUS
========================================= */

async function deleteStatus(
  sock,
  jid,
  key,
  sender
) {
  try {

    await sock.sendMessage(
      jid,
      {
        delete: {
          remoteJid: jid,
          fromMe: false,
          id: key.id,
          participant: sender
        }
      }
    )

    return true

  } catch (error) {

    console.error(
      '[AntiGroupStatus] Delete error:',
      error?.message || error
    )

    return false
  }
}


/* =========================================
   KICK MEMBER
========================================= */

async function kickMember(
  sock,
  jid,
  sender
) {
  try {

    const kickJid =
      await getKickJid(
        sock,
        jid,
        sender
      )

    if (!kickJid) {
      return false
    }

    console.log(
      `[AntiGroupStatus] Kick target: ${kickJid}`
    )

    const result =
      await sock.groupParticipantsUpdate(
        jid,
        [kickJid],
        'remove'
      )

    console.log(
      '[AntiGroupStatus] Kick result:',
      result
    )

    return true

  } catch (error) {

    console.error(
      '[AntiGroupStatus] Kick error:',
      error?.message || error
    )

    return false
  }
}


/* =========================================
   REPLY
========================================= */

async function reply(
  sock,
  message,
  text
) {
  const jid =
    message?.key?.remoteJid

  if (!jid) return

  return sock.sendMessage(
    jid,
    { text },
    { quoted: message }
  )
}


/* =========================================
   COMMAND
========================================= */

export const antigroupstatus = {

  command: [
    'antigroupstatus',
    'ags'
  ],

  async run({
    sock,
    message,
    args,
    isGroup,
    isOwner
  }) {

    const jid =
      message?.key?.remoteJid

    if (!jid) return

    if (!isGroup) {
      return reply(
        sock,
        message,
        '👥 ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs.'
      )
    }

    const sender =
      message.key?.participant ||
      message.key?.participantAlt ||
      jid

    if (!isOwner) {

      const admin =
        await isAdmin(
          sock,
          jid,
          sender
        )

      if (!admin) {
        return reply(
          sock,
          message,
          '🛡️ ᴀᴅᴍɪɴ ᴏɴʟʏ.'
        )
      }
    }

    const db =
      getDatabase()

    const action =
      String(
        args?.[0] || 'status'
      ).toLowerCase()

    const currentMode =
      getMode(db, jid)


    /* STATUS */

    if (action === 'status') {

      let mode =
        '⚪ ᴏғғ'

      if (currentMode === 'on') {
        mode =
          '🟢 ᴏɴ — ᴅᴇʟᴇᴛᴇ + ᴋɪᴄᴋ 5ᴛʜ'
      }

      if (currentMode === 'all') {
        mode =
          '🟣 ᴀʟʟ — ᴅᴇʟᴇᴛᴇ + ᴋɪᴄᴋ 5ᴛʜ'
      }

      return reply(
        sock,
        message,

        `╭─❒ ᴀɴᴛɪ ɢʀᴏᴜᴘ sᴛᴀᴛᴜs ❒
│
│ ᴍᴏᴅᴇ: ${mode}
│
├──────────────
│ .ᴀɢs ᴏɴ
│ .ᴀɢs ᴀʟʟ
│ .ᴀɢs ᴏғғ
│ .ᴀɢs sᴛᴀᴛᴜs
│
╰──────────────`
      )
    }


    /* ON */

    if (action === 'on') {

      setMode(
        db,
        jid,
        'on'
      )

      return reply(
        sock,
        message,

        `✅ ᴀɴᴛɪ-ɢʀᴏᴜᴘ-sᴛᴀᴛᴜs ᴇɴᴀʙʟᴇᴅ

• ᴍᴇᴍʙᴇʀ sᴛᴀᴛᴜs → ᴅᴇʟᴇᴛᴇ
• 5ᴛʜ sᴛᴀᴛᴜs → ᴋɪᴄᴋ
• ᴀᴅᴍɪɴs → ᴇxᴇᴍᴘᴛ
• ᴡᴀʀɴɪɴɢ → ɴᴏɴᴇ`
      )
    }


    /* ALL */

    if (action === 'all') {

      setMode(
        db,
        jid,
        'all'
      )

      return reply(
        sock,
        message,

        `🟣 ᴀɴᴛɪ-ɢʀᴏᴜᴘ-sᴛᴀᴛᴜs ᴀʟʟ ᴍᴏᴅᴇ

• ᴍᴇᴍʙᴇʀ sᴛᴀᴛᴜs → ᴅᴇʟᴇᴛᴇ
• ᴀᴅᴍɪɴ sᴛᴀᴛᴜs → ᴅᴇʟᴇᴛᴇ
• 5ᴛʜ ᴍᴇᴍʙᴇʀ sᴛᴀᴛᴜs → ᴋɪᴄᴋ
• ᴀᴅᴍɪɴs → ɴᴇᴠᴇʀ ᴋɪᴄᴋᴇᴅ
• ᴡᴀʀɴɪɴɢ → ɴᴏɴᴇ`
      )
    }


    /* OFF */

    if (action === 'off') {

      setMode(
        db,
        jid,
        false
      )

      return reply(
        sock,
        message,
        '❌ ᴀɴᴛɪ-ɢʀᴏᴜᴘ-sᴛᴀᴛᴜs ᴅɪsᴀʙʟᴇᴅ.'
      )
    }


    return reply(
      sock,
      message,

      `❓ ᴜɴᴋɴᴏᴡɴ ᴏᴘᴛɪᴏɴ: ${action}

ᴜsᴇ:

.ᴀɢs ᴏɴ
.ᴀɢs ᴀʟʟ
.ᴀɢs ᴏғғ
.ᴀɢs sᴛᴀᴛᴜs`
    )
  }
}


/* =========================================
   GROUP STATUS LISTENER
========================================= */

export const antigroupstatusListener = {

  command:
    '__antigroupstatus_listener',

  async run({
    sock,
    message,
    isStatus
  }) {

    if (!isStatus) return
    if (!message?.message) return

    const key =
      message.key || {}

    const jid =
      key.remoteJid

    if (
      !jid ||
      !jid.endsWith('@g.us')
    ) {
      return
    }

    const db =
      getDatabase()

    const mode =
      getMode(db, jid)

    if (!mode) return

    const sender =
      key.participant ||
      key.participantAlt

    if (!sender) return


    /* =====================================
       FIND ACTUAL PARTICIPANT
    ===================================== */

    const participant =
      await getParticipant(
        sock,
        jid,
        sender
      )

    if (!participant) {
      console.log(
        `[AntiGroupStatus] Could not resolve participant: ${sender}`
      )

      return
    }

    const actualJid =
      participant.id || sender

    const admin =
      participant.admin === 'admin' ||
      participant.admin === 'superadmin'


    /* =====================================
       ON MODE
    ===================================== */

    if (mode === 'on') {

      /*
       * Admins are exempt.
       */
      if (admin) {
        return
      }

      /*
       * Delete status.
       */
      await deleteStatus(
        sock,
        jid,
        key,
        sender
      )

      /*
       * Count using actual participant.
       */
      const count =
        addViolation(
          db,
          jid,
          actualJid
        )

      console.log(
        `[AntiGroupStatus] ON ${actualJid}: ${count}/5`
      )

      /*
       * Fifth status = kick.
       */
      if (count >= 5) {

        const kicked =
          await kickMember(
            sock,
            jid,
            actualJid
          )

        if (kicked) {

          resetViolation(
            db,
            jid,
            actualJid
          )
        }
      }

      return
    }


    /* =====================================
       ALL MODE
    ===================================== */

    if (mode === 'all') {

      /*
       * Delete everyone.
       */
      await deleteStatus(
        sock,
        jid,
        key,
        sender
      )

      /*
       * Admins never kicked.
       */
      if (admin) {
        return
      }

      /*
       * Count using actual participant.
       */
      const count =
        addViolation(
          db,
          jid,
          actualJid
        )

      console.log(
        `[AntiGroupStatus] ALL ${actualJid}: ${count}/5`
      )

      /*
       * Fifth status = kick.
       */
      if (count >= 5) {

        const kicked =
          await kickMember(
            sock,
            jid,
            actualJid
          )

        if (kicked) {

          resetViolation(
            db,
            jid,
            actualJid
          )
        }
      }
    }
  }
}


/* =========================================
   DEFAULT EXPORT
========================================= */

export default {
  ...antigroupstatus
}