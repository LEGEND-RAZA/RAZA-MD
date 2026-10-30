import mysql from 'mysql2/promise'

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'defaultdb',
  ssl: {
    rejectUnauthorized: false
  },
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0
})

/*
 * ==============================
 * BOT IDENTITY
 * ==============================
 * Priority order (highest to lowest):
 *   1. SESSION_ID       — unique per pair, stable across restarts, always set
 *   2. HEROKU_APP_NAME  — unique per Heroku app (if on Heroku)
 *   3. BOT_ID           — manual override for non-Heroku deployments
 *   4. 'raza-md-default' — legacy fallback (will WARN loudly)
 *
 * SESSION_ID is the safest key because every bot that pairs gets a fresh
 * unique token, even if two users pick the same display name or Heroku
 * app name. Data stays isolated per bot regardless of naming.
 *
 * Trade-off: re-pairing a bot creates a new SESSION_ID → fresh settings.
 * Use DB_MIGRATE_FROM to copy old data across when re-pairing.
 */

const SOURCES = {
  SESSION_ID: (process.env.SESSION_ID || '').trim(),
  HEROKU_APP_NAME: (process.env.HEROKU_APP_NAME || '').trim(),
  BOT_ID: (process.env.BOT_ID || '').trim()
}

const BOT_ID =
  SOURCES.SESSION_ID ||
  SOURCES.HEROKU_APP_NAME ||
  SOURCES.BOT_ID ||
  'raza-md-default'

const BOT_ID_SOURCE =
  SOURCES.SESSION_ID
    ? 'SESSION_ID'
    : SOURCES.HEROKU_APP_NAME
      ? 'HEROKU_APP_NAME'
      : SOURCES.BOT_ID
        ? 'BOT_ID'
        : 'default'

if (BOT_ID === 'raza-md-default') {
  console.error(
    '[DB] ⚠️  WARNING: No SESSION_ID, HEROKU_APP_NAME, or BOT_ID set.\n' +
    '[DB] ⚠️  Using shared namespace "raza-md-default" — this WILL COLLIDE\n' +
    '[DB] ⚠️  with every other bot using the same fallback.\n' +
    '[DB] ⚠️  Set SESSION_ID on this dyno to isolate this bot.'
  )
}

const shortId =
  BOT_ID.length > 24
    ? `${BOT_ID.slice(0, 16)}…${BOT_ID.slice(-6)}`
    : BOT_ID

console.log(
  `[DB] BOT_ID: ${shortId} (source: ${BOT_ID_SOURCE})`
)

const cache = new Map()
const saveQueues = new Map()

/*
 * ==============================
 * SCHEMA BOOTSTRAP
 * ==============================
 */

await pool.execute(`
  CREATE TABLE IF NOT EXISTS bot_database (
    bot_id VARCHAR(255) NOT NULL,
    filename VARCHAR(255) NOT NULL,
    data JSON NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (bot_id, filename)
  )
`)

/*
 * ==============================
 * SCHEMA MIGRATION (legacy upgrades)
 * ==============================
 * These blocks upgrade very old tables that lacked bot_id or had a
 * single-column primary key. Safe to run repeatedly — the checks skip
 * once the schema is correct.
 */

const [columns] = await pool.execute(`
  SELECT COLUMN_NAME
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'bot_database'
`)

const hasBotId = columns.some(
  column => column.COLUMN_NAME === 'bot_id'
)

if (!hasBotId) {
  await pool.execute(`
    ALTER TABLE bot_database
    ADD COLUMN bot_id VARCHAR(255) NULL
    AFTER filename
  `)

  await pool.execute(
    `UPDATE bot_database SET bot_id = ? WHERE bot_id IS NULL`,
    [BOT_ID]
  )

  await pool.execute(`
    ALTER TABLE bot_database
    MODIFY COLUMN bot_id VARCHAR(255) NOT NULL
  `)

  await pool.execute(`
    ALTER TABLE bot_database
    DROP PRIMARY KEY,
    ADD PRIMARY KEY (bot_id, filename)
  `)

  console.log('[DB] Schema migrated: added bot_id column + composite PK')
} else {
  const [primaryKeyRows] = await pool.execute(`
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'bot_database'
      AND CONSTRAINT_NAME = 'PRIMARY'
    ORDER BY ORDINAL_POSITION
  `)

  const primaryKey = primaryKeyRows.map(row => row.COLUMN_NAME)

  const correctPrimaryKey =
    primaryKey.length === 2 &&
    primaryKey[0] === 'bot_id' &&
    primaryKey[1] === 'filename'

  if (!correctPrimaryKey) {
    await pool.execute(`
      ALTER TABLE bot_database
      DROP PRIMARY KEY,
      ADD PRIMARY KEY (bot_id, filename)
    `)
    console.log('[DB] Schema migrated: composite PK (bot_id, filename)')
  }
}

/*
 * ==============================
 * OPTIONAL: ONE-TIME MIGRATION
 * ==============================
 * If you recently changed BOT_ID (e.g. from HEROKU_APP_NAME → SESSION_ID),
 * set DB_MIGRATE_FROM to the old BOT_ID on the dyno. This copies the rows
 * once, only if the new BOT_ID namespace is currently empty.
 *
 *   heroku config:set DB_MIGRATE_FROM=old-raza-md-value -a <bot-app>
 *
 * After a successful migration, remove the env var so it doesn't run again.
 */

const MIGRATE_FROM = (process.env.DB_MIGRATE_FROM || '').trim()

if (MIGRATE_FROM && MIGRATE_FROM !== BOT_ID) {
  try {
    const [[{ c: oldCount }]] = await pool.execute(
      'SELECT COUNT(*) as c FROM bot_database WHERE bot_id = ?',
      [MIGRATE_FROM]
    )
    const [[{ c: newCount }]] = await pool.execute(
      'SELECT COUNT(*) as c FROM bot_database WHERE bot_id = ?',
      [BOT_ID]
    )

    if (oldCount > 0 && newCount === 0) {
      await pool.execute(
        'UPDATE bot_database SET bot_id = ? WHERE bot_id = ?',
        [BOT_ID, MIGRATE_FROM]
      )
      console.log(
        `[DB] Migrated ${oldCount} rows from "${MIGRATE_FROM}" → "${shortId}"`
      )
      console.log(
        `[DB] Remove DB_MIGRATE_FROM from this dyno to prevent repeat migration`
      )
    } else if (newCount > 0) {
      console.log(
        `[DB] Migration skipped: "${shortId}" already has ${newCount} rows`
      )
    } else {
      console.log(
        `[DB] Migration skipped: no rows found under "${MIGRATE_FROM}"`
      )
    }
  } catch (e) {
    console.error('[DB] Migration error:', e?.message || e)
  }
}

/*
 * ==============================
 * LOAD CURRENT BOT DATA
 * ==============================
 */

const [rows] = await pool.execute(
  `
  SELECT filename, data
  FROM bot_database
  WHERE bot_id = ?
  `,
  [BOT_ID]
)

for (const row of rows) {
  try {
    cache.set(
      row.filename,
      typeof row.data === 'string'
        ? JSON.parse(row.data)
        : row.data
    )
  } catch (err) {
    console.error(
      `[DB LOAD ERROR] ${row.filename}:`,
      err.message
    )
  }
}

console.log(
  `[DB] MySQL connected: ${rows.length} database entries loaded for ${shortId}`
)

/**
 * Reads data from MySQL
 */
export function getDb(filename, defaultData = {}) {
  const key = filename.endsWith('.json')
    ? filename
    : `${filename}.json`

  if (!cache.has(key)) {
    const data = structuredClone(defaultData)
    cache.set(key, data)
    saveDb(key, data)
  }

  return cache.get(key)
}

/**
 * Saves data to MySQL
 */
export function saveDb(filename, data) {
  const key = filename.endsWith('.json')
    ? filename
    : `${filename}.json`

  cache.set(key, data)

  const queueKey = `${BOT_ID}:${key}`

  const previousSave =
    saveQueues.get(queueKey) ||
    Promise.resolve()

  const currentSave =
    previousSave
      .catch(() => {})
      .then(async () => {
        try {
          await pool.execute(
            `
            INSERT INTO bot_database
              (bot_id, filename, data)
            VALUES
              (?, ?, ?)
            ON DUPLICATE KEY UPDATE
              data = VALUES(data),
              updated_at = CURRENT_TIMESTAMP
            `,
            [
              BOT_ID,
              key,
              JSON.stringify(data)
            ]
          )
        } catch (err) {
          console.error(
            `[DB SAVE ERROR] ${key}:`,
            err.message
          )
        }
      })

  saveQueues.set(queueKey, currentSave)

  return true
}

/**
 * Closes MySQL connection
 */
export async function closeDb() {
  await pool.end()
}
