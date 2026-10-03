require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { Client, GatewayIntentBits, SlashCommandBuilder, MessageFlags } = require('discord.js');

const required = ['DATABASE_URL', 'DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID', 'ADMIN_API_SECRET'];
for (const name of required) if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }, max: Number(process.env.DB_POOL_MAX || 10), idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '20kb' }));
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, message: { valid: false, error: 'Too many attempts. Please wait and try again.' } });
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const safeUsername = s => typeof s === 'string' && /^[A-Za-z0-9_.-]{3,24}$/.test(s);
const newKey = () => 'HOOP-' + crypto.randomBytes(4).toString('hex').toUpperCase() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
const adminIds = () => (process.env.ADMIN_USER_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
const privateReply = (i, content) => i.reply({ content, flags: MessageFlags.Ephemeral });

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS licenses (
    key_hash TEXT PRIMARY KEY, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL,
    disabled BOOLEAN NOT NULL DEFAULT FALSE, activated_at BIGINT, activated_by TEXT,
    label TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY, username_display TEXT NOT NULL, user_id UUID NOT NULL UNIQUE,
    salt TEXT NOT NULL, password_hash TEXT NOT NULL, disabled BOOLEAN NOT NULL DEFAULT FALSE,
    created_at BIGINT NOT NULL, license_key_hash TEXT NOT NULL REFERENCES licenses(key_hash), expires_at BIGINT
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS sessions_username_idx ON sessions(username)');
  await pool.query('CREATE INDEX IF NOT EXISTS licenses_expiry_idx ON licenses(expires_at)');
}

app.get('/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, database: 'connected' }); }
  catch { res.status(503).json({ ok: false, database: 'unavailable' }); }
});
app.post('/register', authLimiter, async (req, res) => {
  const { key, username, password } = req.body || {};
  if (typeof key !== 'string' || !safeUsername(username) || typeof password !== 'string' || password.length < 8 || password.length > 200)
    return res.status(400).json({ valid: false, error: 'Use a valid key, a 3–24 character username, and a password of at least 8 characters.' });
  const keyHash = hash(key.trim().toUpperCase()), uname = username.toLowerCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM licenses WHERE key_hash=$1 FOR UPDATE', [keyHash]);
    const license = result.rows[0];
    if (!license) { await client.query('ROLLBACK'); return res.status(401).json({ valid: false, error: 'Invalid key.' }); }
    if (license.disabled) { await client.query('ROLLBACK'); return res.status(403).json({ valid: false, error: 'This key is disabled.' }); }
    if (Number(license.expires_at) < Date.now()) { await client.query('ROLLBACK'); return res.status(403).json({ valid: false, error: 'This key has expired.' }); }
    if (license.activated_at) { await client.query('ROLLBACK'); return res.status(409).json({ valid: false, error: 'This key has already been used. Contact an administrator.' }); }
    if ((await client.query('SELECT 1 FROM users WHERE username=$1', [uname])).rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ valid: false, error: 'That username is already taken.' }); }
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');
    await client.query('INSERT INTO users(username,username_display,user_id,salt,password_hash,created_at,license_key_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [uname, username, crypto.randomUUID(), salt, passwordHash, Date.now(), keyHash, license.expires_at]);
    await client.query('UPDATE licenses SET activated_at=$1, activated_by=$2 WHERE key_hash=$3', [Date.now(), uname, keyHash]);
    await client.query('COMMIT');
    res.json({ valid: true, username, expiresAt: Number(license.expires_at) });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') return res.status(409).json({ valid: false, error: 'That username is already taken.' });
    console.error('register failed', e); res.status(500).json({ valid: false, error: 'Server error. Please try again later.' });
  } finally { client.release(); }
});
app.post('/login', authLimiter, async (req, res) => {
  const { username, password, rememberMe } = req.body || {};
  if (!safeUsername(username) || typeof password !== 'string' || password.length > 200) return res.status(400).json({ valid: false, error: 'Invalid username or password.' });
  try {
    const result = await pool.query(
      `SELECT u.*, l.disabled AS license_disabled, l.expires_at AS license_expires_at
       FROM users u
       JOIN licenses l ON l.key_hash = u.license_key_hash
       WHERE u.username=$1`,
      [username.toLowerCase()]
    );
    const user = result.rows[0];
    if (!user || user.disabled) return res.status(401).json({ valid: false, error: 'Invalid username or password, or account disabled.' });
    const actual = crypto.scryptSync(password, user.salt, 64), expected = Buffer.from(user.password_hash, 'hex');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return res.status(401).json({ valid: false, error: 'Invalid username or password.' });
    if (user.license_disabled) return res.status(403).json({ valid: false, error: 'Your license key has been disabled.' });
    if (user.expires_at && Number(user.expires_at) < Date.now()) return res.status(403).json({ valid: false, error: 'Your license has expired.' });
    if (user.license_expires_at && Number(user.license_expires_at) < Date.now()) return res.status(403).json({ valid: false, error: 'Your license has expired.' });
    const token = crypto.randomBytes(32).toString('hex'), now = Date.now(), expires = now + (rememberMe ? 30 : 1) * 86400000;
    await pool.query('INSERT INTO sessions(token_hash,username,created_at,expires_at) VALUES($1,$2,$3,$4)', [hash(token), user.username, now, expires]);
    res.json({ valid: true, username: user.username_display, sessionToken: token, expiresAt: user.expires_at ? Number(user.expires_at) : null });
  } catch (e) { console.error('login failed', e); res.status(500).json({ valid: false, error: 'Server error. Please try again later.' }); }
});
app.post('/session', async (req, res) => {
  const token = req.body && req.body.sessionToken;
  if (typeof token !== 'string' || token.length < 32) return res.status(401).json({ valid: false });
  try {
    const r = await pool.query(
      `SELECT u.username_display,u.disabled,u.expires_at,
              l.disabled AS license_disabled,l.expires_at AS license_expires_at,
              s.expires_at AS session_expires
       FROM sessions s
       JOIN users u ON u.username=s.username
       JOIN licenses l ON l.key_hash=u.license_key_hash
       WHERE s.token_hash=$1`,
      [hash(token)]
    );
    const row = r.rows[0];
    if (!row || row.disabled || row.license_disabled ||
        Number(row.session_expires) < Date.now() ||
        (row.expires_at && Number(row.expires_at) < Date.now()) ||
        (row.license_expires_at && Number(row.license_expires_at) < Date.now())) {
      await pool.query('DELETE FROM sessions WHERE token_hash=$1', [hash(token)]); return res.status(401).json({ valid: false });
    }
    res.json({ valid: true, username: row.username_display, expiresAt: row.expires_at ? Number(row.expires_at) : null });
  } catch (e) { console.error('session check failed', e); res.status(500).json({ valid: false }); }
});
app.post('/disable-account', async (req, res) => {
  if (!process.env.ADMIN_API_SECRET || req.get('x-admin-secret') !== process.env.ADMIN_API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const username = String((req.body || {}).username || '').toLowerCase();
  try {
    const r = await pool.query('UPDATE users SET disabled=TRUE WHERE username=$1', [username]);
    if (!r.rowCount) return res.status(404).json({ error: 'User not found' });
    await pool.query('DELETE FROM sessions WHERE username=$1', [username]); res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('ready', () => console.log(`Discord bot logged in as ${client.user.tag}`));
client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return;
  if (i.commandName === 'ping') return privateReply(i, 'Pong! Bot is online.');
  if (!adminIds().includes(i.user.id)) return privateReply(i, 'You are not authorized to use this command.');
  const cmd = i.commandName;
  try {
    if (cmd === 'createkey') {
      const days = i.options.getInteger('days', true), label = i.options.getString('label') || '', key = newKey(), keyHash = hash(key), now = Date.now(), expiry = now + days * 86400000;
      await pool.query('INSERT INTO licenses(key_hash,created_at,expires_at,label,created_by) VALUES($1,$2,$3,$4,$5)', [keyHash, now, expiry, label, i.user.id]);
      return privateReply(i, `New key (shown only to you):\n\`${key}\`\nExpires in ${days} day(s). Give this key privately to its recipient.`);
    }
    if (['keyinfo','disablekey','enablekey','resetkey'].includes(cmd)) {
      const key = i.options.getString('key', true).trim().toUpperCase(), keyHash = hash(key);
      const found = await pool.query('SELECT * FROM licenses WHERE key_hash=$1', [keyHash]);
      const lic = found.rows[0]; if (!lic) return privateReply(i, 'Key not found.');
      if (cmd === 'keyinfo') return privateReply(i, `**Status:** ${lic.disabled ? 'Disabled' : (lic.activated_at ? `Activated by ${lic.activated_by}` : 'Unused')}\n**Expires:** <t:${Math.floor(Number(lic.expires_at)/1000)}:F>\n**Label:** ${lic.label || '—'}`);
      if (cmd === 'disablekey') {
        await pool.query('UPDATE licenses SET disabled=TRUE WHERE key_hash=$1', [keyHash]);
        // Immediately invalidate sessions for the account activated by this key.
        await pool.query(
          `DELETE FROM sessions
           WHERE username IN (SELECT username FROM users WHERE license_key_hash=$1)`,
          [keyHash]
        );
      }
      if (cmd === 'enablekey') await pool.query('UPDATE licenses SET disabled=FALSE WHERE key_hash=$1', [keyHash]);
      if (cmd === 'resetkey') {
        const c = await pool.connect(); try { await c.query('BEGIN'); await c.query('DELETE FROM users WHERE license_key_hash=$1', [keyHash]); await c.query('UPDATE licenses SET activated_at=NULL,activated_by=NULL WHERE key_hash=$1', [keyHash]); await c.query('COMMIT'); } catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
      }
      return privateReply(i, cmd === 'disablekey' ? 'Key disabled.' : cmd === 'enablekey' ? 'Key enabled.' : 'Key reset; the account created with it was removed.');
    }
    if (cmd === 'disableaccount' || cmd === 'enableaccount') {
      const username = i.options.getString('username', true).toLowerCase(), disabled = cmd === 'disableaccount';
      const r = await pool.query('UPDATE users SET disabled=$1 WHERE username=$2', [disabled, username]);
      if (!r.rowCount) return privateReply(i, 'User not found.');
      if (disabled) await pool.query('DELETE FROM sessions WHERE username=$1', [username]);
      return privateReply(i, disabled ? 'Account disabled.' : 'Account enabled.');
    }
  } catch (e) { console.error('Discord command failed', e); if (!i.replied) await privateReply(i, 'Something went wrong. Check the server logs.'); }
});

(async () => {
  await initDb();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => console.log(`API listening on port ${port}`));
  await client.login(process.env.DISCORD_TOKEN);
})().catch(e => { console.error('Startup failed', e); process.exit(1); });
process.on('SIGTERM', async () => { await pool.end(); client.destroy(); process.exit(0); });
