import pg from 'pg';

// DATE columns come back as 'YYYY-MM-DD' strings (no timezone shifting),
// NUMERIC columns as JS numbers.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1700, (v) => Number(v));

export const UNITS = ['$', '%', 'count', 'days', 'weeks', 'score'];
export const DIRECTIONS = ['higher', 'lower'];

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const ssl = process.env.DATABASE_SSL === '1' || process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined;
  return new pg.Pool({ connectionString, ssl, max: 5 });
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lanes (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  color       TEXT NOT NULL DEFAULT '#6b7280'
);
CREATE TABLE IF NOT EXISTS goals (
  id          SERIAL PRIMARY KEY,
  lane_id     INTEGER NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kpi         TEXT NOT NULL DEFAULT '',
  unit        TEXT CHECK (unit IN ('$', '%', 'count', 'days', 'weeks', 'score')),
  direction   TEXT CHECK (direction IN ('higher', 'lower')),
  baseline    NUMERIC,
  target      NUMERIC,
  start_date  DATE NOT NULL,
  due_date    DATE NOT NULL,
  CONSTRAINT goals_due_after_start CHECK (due_date >= start_date)
);
CREATE INDEX IF NOT EXISTS goals_lane_idx ON goals(lane_id);
CREATE TABLE IF NOT EXISTS milestones (
  id           SERIAL PRIMARY KEY,
  goal_id      INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  date         DATE NOT NULL,
  done         BOOLEAN NOT NULL DEFAULT FALSE,
  completed_on DATE
);
CREATE INDEX IF NOT EXISTS milestones_goal_idx ON milestones(goal_id);
CREATE TABLE IF NOT EXISTS touchpoints (
  id       SERIAL PRIMARY KEY,
  goal_id  INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  date     DATE NOT NULL,
  value    NUMERIC NOT NULL,
  note     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS touchpoints_goal_idx ON touchpoints(goal_id);

-- KPI fields are optional (a goal can be milestone-only); relax older databases.
ALTER TABLE goals ALTER COLUMN unit DROP NOT NULL;
ALTER TABLE goals ALTER COLUMN direction DROP NOT NULL;
ALTER TABLE goals ALTER COLUMN baseline DROP NOT NULL;
ALTER TABLE goals ALTER COLUMN target DROP NOT NULL;
`;

export async function migrate(pool) {
  await pool.query(SCHEMA);
}

// API field name → column, plus the kind used for validation.
export const TABLES = {
  lanes: {
    fields: {
      name: ['name', 'text'],
      order: ['sort_order', 'int'],
      color: ['color', 'color'],
    },
    required: ['name'],
    orderBy: 'sort_order, id',
  },
  goals: {
    fields: {
      laneId: ['lane_id', 'id'],
      name: ['name', 'text'],
      description: ['description', 'longtext'],
      kpi: ['kpi', 'text?'],
      unit: ['unit', 'unit?'],
      direction: ['direction', 'direction?'],
      baseline: ['baseline', 'number?'],
      target: ['target', 'number?'],
      startDate: ['start_date', 'date'],
      dueDate: ['due_date', 'date'],
    },
    required: ['laneId', 'name', 'startDate', 'dueDate'],
    orderBy: 'due_date, id',
  },
  milestones: {
    fields: {
      goalId: ['goal_id', 'id'],
      name: ['name', 'text'],
      date: ['date', 'date'],
      done: ['done', 'bool'],
      completedOn: ['completed_on', 'date?'],
    },
    required: ['goalId', 'name', 'date'],
    orderBy: 'date, id',
  },
  touchpoints: {
    fields: {
      goalId: ['goal_id', 'id'],
      date: ['date', 'date'],
      value: ['value', 'number'],
      note: ['note', 'longtext'],
    },
    required: ['goalId', 'date', 'value'],
    orderBy: 'date, id',
  },
};

export function selectList(table) {
  const cols = Object.entries(TABLES[table].fields).map(([key, [col]]) => `${col} AS "${key}"`);
  return ['id', ...cols].join(', ');
}

export class ValidationError extends Error {}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function coerce(kind, key, value) {
  const fail = (why) => {
    throw new ValidationError(`${key}: ${why}`);
  };
  switch (kind) {
    case 'text': {
      const s = String(value ?? '').trim();
      if (!s) fail('required');
      if (s.length > 200) fail('too long');
      return s;
    }
    case 'text?': {
      const s = String(value ?? '').trim();
      if (s.length > 200) fail('too long');
      return s;
    }
    case 'longtext': {
      const s = String(value ?? '').trim();
      if (s.length > 5000) fail('too long');
      return s;
    }
    case 'int':
    case 'id': {
      const n = Number(value);
      if (!Number.isInteger(n) || (kind === 'id' && n <= 0)) fail('must be an integer');
      return n;
    }
    case 'number': {
      if (value === '' || value === null || value === undefined) fail('required');
      const n = Number(value);
      if (!Number.isFinite(n)) fail('must be a number');
      return n;
    }
    case 'number?': {
      if (value === '' || value === null || value === undefined) return null;
      const n = Number(value);
      if (!Number.isFinite(n)) fail('must be a number');
      return n;
    }
    case 'bool':
      return value === true || value === 'true' || value === 1;
    case 'date':
      if (!isRealDate(String(value))) fail('must be a date (YYYY-MM-DD)');
      return String(value);
    case 'date?':
      if (value === null || value === '' || value === undefined) return null;
      if (!isRealDate(String(value))) fail('must be a date (YYYY-MM-DD)');
      return String(value);
    case 'color':
      if (!/^#[0-9a-fA-F]{6}$/.test(String(value))) fail('must be a hex color like #3366aa');
      return String(value).toLowerCase();
    case 'unit?':
      if (value === null || value === '' || value === undefined) return null;
      if (!UNITS.includes(value)) fail(`must be one of ${UNITS.join(', ')}`);
      return value;
    case 'direction?':
      if (value === null || value === '' || value === undefined) return null;
      if (!DIRECTIONS.includes(value)) fail('must be "higher" or "lower"');
      return value;
    default:
      throw new Error(`unknown kind ${kind}`);
  }
}

/** Validate a request body for `table`. Returns {column: value}. */
export function validate(table, body, { partial = false } = {}) {
  const { fields, required } = TABLES[table];
  if (!body || typeof body !== 'object') throw new ValidationError('expected a JSON object');
  const out = {};
  for (const [key, [col, kind]] of Object.entries(fields)) {
    if (!(key in body)) {
      if (!partial && required.includes(key)) throw new ValidationError(`${key}: required`);
      continue;
    }
    out[col] = coerce(kind, key, body[key]);
  }
  if (partial && Object.keys(out).length === 0) throw new ValidationError('nothing to update');
  if (table === 'goals') {
    if (!partial && !('kpi' in out)) out.kpi = '';
    goalRules(out, partial);
  }
  return out;
}

// A goal either tracks a KPI (label + unit + direction; baseline and target may
// be filled in later) or is milestone-only, in which case the KPI fields are cleared.
function goalRules(row, partial) {
  if (!('kpi' in row)) return;
  if (!row.kpi) {
    Object.assign(row, { kpi: '', unit: null, direction: null, baseline: null, target: null });
    return;
  }
  if (partial) return;
  row.unit ??= 'count';
  row.direction ??= 'higher';
}
