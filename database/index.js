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

const BOT_ID =
  process.env.HEROKU_APP_NAME ||
  process.env.BOT_ID ||
  'raza-md-default'

const cache = new Map()
const saveQueues = new Map()

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
 * DATABASE MIGRATION
 * ==============================
 */

const [columns] = await pool.execute(`
  SELECT COLUMN_NAME
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'bot_database'
`)

const hasBotId =
  columns.some(
    column =>
      column.COLUMN_NAME === 'bot_id'
  )

if (!hasBotId) {
  await pool.execute(`
    ALTER TABLE bot_database
    ADD COLUMN bot_id VARCHAR(255) NULL
    AFTER filename
  `)

  await pool.execute(
    `
    UPDATE bot_database
    SET bot_id = ?
    WHERE bot_id IS NULL
    `,
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
} else {
  const [primaryKeyRows] =
    await pool.execute(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'bot_database'
        AND CONSTRAINT_NAME = 'PRIMARY'
      ORDER BY ORDINAL_POSITION
    `)

  const primaryKey =
    primaryKeyRows.map(
      row => row.COLUMN_NAME
    )

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
  `[DB] MySQL connected: ${rows.length} database entries loaded for ${BOT_ID}`
)

/**
 * Reads data from MySQL
 */
export function getDb(filename, defaultData = {}) {
  const key = filename.endsWith('.json')
    ? filename
    : `${filename}.json`

  if (!cache.has(key)) {
    const data =
      structuredClone(defaultData)

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

  const queueKey =
    `${BOT_ID}:${key}`

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

  saveQueues.set(
    queueKey,
    currentSave
  )

  return true
}

/**
 * Closes MySQL connection
 */
export async function closeDb() {
  await pool.end()
}
