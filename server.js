import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createPool, migrate, selectList, TABLES, validate, ValidationError } from './db.js';
import { isEmpty, readPlanFile, seed } from './seed.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const PASSWORD = process.env.APP_PASSWORD;
if (!PASSWORD) {
  console.error('APP_PASSWORD is not set; refusing to start.');
  process.exit(1);
}
const SECRET = process.env.SESSION_SECRET || PASSWORD;
const COOKIE = 'plan_session';
const COOKIE_MAX_AGE = 90 * 24 * 3600; // seconds

// The session token is derived from the password, so changing APP_PASSWORD
// (or SESSION_SECRET) signs everyone out.
const TOKEN = crypto.createHmac('sha256', SECRET).update(`plan-session:${PASSWORD}`).digest('base64url');

const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

const isAuthed = (req) => {
  const c = readCookie(req, COOKIE);
  return c !== null && safeEqual(c, TOKEN);
};

const pool = createPool();
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.get('/healthz', async (_req, res) => {
  await pool.query('SELECT 1');
  res.type('text').send('ok');
});

// ---- auth -----------------------------------------------------------------

const loginPage = (error = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Plan</title><link rel="stylesheet" href="/style.css"><script src="/theme.js"></script></head>
<body class="login"><form method="post" action="/login" class="login-box">
<h1>Plan</h1>
<label>Password<input type="password" name="password" autofocus autocomplete="current-password" required></label>
${error ? `<p class="error">${error}</p>` : ''}
<button type="submit" class="primary">Sign in</button>
</form></body></html>`;

app.get('/login', (req, res) => {
  if (isAuthed(req)) return res.redirect('/');
  res.type('html').send(loginPage());
});

app.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
  if (safeEqual(req.body?.password ?? '', PASSWORD)) {
    res.cookie(COOKIE, TOKEN, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: COOKIE_MAX_AGE * 1000,
      path: '/',
    });
    return res.redirect('/');
  }
  await new Promise((r) => setTimeout(r, 600)); // slow down guessing
  res.status(401).type('html').send(loginPage('Wrong password.'));
});

app.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.redirect('/login');
});

// Public assets needed by the login page.
app.get(['/style.css', '/theme.js'], (req, res) => res.sendFile(path.join(here, 'public', req.path)));

app.use((req, res, next) => {
  if (isAuthed(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  res.redirect('/login');
});

// ---- API ------------------------------------------------------------------

const api = express.Router();
api.use(express.json({ limit: '100kb' }));

// Mutations must be JSON: blocks cross-site form posts even without CSRF tokens.
api.use((req, res, next) => {
  if (req.method !== 'GET' && !req.is('application/json')) {
    return res.status(415).json({ error: 'expected application/json' });
  }
  next();
});

api.get('/state', async (_req, res) => {
  const out = {};
  for (const table of Object.keys(TABLES)) {
    const { rows } = await pool.query(`SELECT ${selectList(table)} FROM ${table} ORDER BY ${TABLES[table].orderBy}`);
    out[table] = rows;
  }
  res.json(out);
});

async function insertRow(table, values) {
  const cols = Object.keys(values);
  const { rows } = await pool.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING ${selectList(table)}`,
    Object.values(values),
  );
  return rows[0];
}

async function updateRow(table, id, values) {
  const cols = Object.keys(values);
  const { rows } = await pool.query(
    `UPDATE ${table} SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING ${selectList(table)}`,
    [id, ...Object.values(values)],
  );
  return rows[0];
}

const parseId = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('bad id');
  return id;
};

// Keep done/completed_on consistent: checking stamps a date, unchecking clears it.
function milestoneRules(values, body) {
  if (values.done === true && !('completed_on' in values)) {
    values.completed_on = body.today && /^\d{4}-\d{2}-\d{2}$/.test(body.today) ? body.today : new Date().toISOString().slice(0, 10);
  }
  if (values.done === false) values.completed_on = null;
  return values;
}

for (const table of Object.keys(TABLES)) {
  api.post(`/${table}`, async (req, res) => {
    let values = validate(table, req.body);
    if (table === 'lanes' && !('sort_order' in values)) {
      const { rows } = await pool.query('SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM lanes');
      values.sort_order = rows[0].next;
    }
    if (table === 'milestones') values = milestoneRules(values, req.body);
    res.status(201).json(await insertRow(table, values));
  });

  api.patch(`/${table}/:id`, async (req, res) => {
    const id = parseId(req);
    let values = validate(table, req.body, { partial: true });
    if (table === 'milestones') values = milestoneRules(values, req.body);
    const row = await updateRow(table, id, values);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  });

  api.delete(`/${table}/:id`, async (req, res) => {
    const { rowCount } = await pool.query(`DELETE FROM ${table} WHERE id = $1`, [parseId(req)]);
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  });
}

// Reorder lanes in one go: body { ids: [laneId, ...] } in the new order.
api.put('/lanes-order', async (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || !ids.every((n) => Number.isInteger(n))) throw new ValidationError('ids: expected an array of lane ids');
  await pool.query(
    'UPDATE lanes SET sort_order = o.ord FROM unnest($1::int[]) WITH ORDINALITY AS o(id, ord) WHERE lanes.id = o.id',
    [ids],
  );
  res.status(204).end();
});

app.use('/api', api);

app.use(express.static(path.join(here, 'public'), { index: 'index.html' }));

// Errors: validation and constraint failures are the client's fault.
app.use((err, req, res, _next) => {
  const pgClientErrors = { 23503: 'referenced row does not exist', 23514: 'value violates a constraint (is the due date before the start date?)', 22003: 'number out of range' };
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
  if (err.code in pgClientErrors) return res.status(400).json({ error: pgClientErrors[err.code] });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

// ---- boot -----------------------------------------------------------------

await migrate(pool);

const seedFile = path.resolve(here, process.env.SEED_FILE || 'plan.json');
if (fs.existsSync(seedFile) && (await isEmpty(pool))) {
  try {
    const counts = await seed(pool, readPlanFile(seedFile));
    console.log(`Seeded empty database from ${path.basename(seedFile)}:`, counts);
  } catch (e) {
    console.error(`Could not seed from ${seedFile}: ${e.message}`);
  }
}

app.listen(PORT, () => console.log(`Plan listening on :${PORT}`));
