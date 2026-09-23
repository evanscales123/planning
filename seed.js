// Seed the database from a plan.json file.
//
//   npm run seed -- plan.json            # only if the database is empty
//   npm run seed -- plan.json --reset    # wipe everything, then load
//
// Two shapes are accepted (see plan.example.json and README.md):
//   nested: { lanes: [ { name, color, goals: [ { ..., milestones: [], touchpoints: [] } ] } ] }
//   flat:   { lanes: [...], goals: [{ lane: "<lane name>", ... }],
//             milestones: [{ goal: "<goal name>", ... }], touchpoints: [{ goal: "<goal name>", ... }] }
// Both can be mixed. Keys may be camelCase or snake_case. A goal's "notes"
// are appended to its description, and "draft": true is noted there too.
// Goals may leave baseline/target null, or omit the KPI entirely.
// A lane's "company": "<name>" links it to that company (created if needed).
// Other keys (ids, lane missions, milestone notes, meta) are ignored.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, migrate, validate, ValidationError } from './db.js';

const PALETTE = ['#4f6d8f', '#8a6d3b', '#5b7f5b', '#8f4f6d', '#6d5b8f', '#3b7f7f', '#8f6d4f'];

const pick = (obj, ...keys) => {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
};

const joinText = (...parts) => parts.filter((p) => typeof p === 'string' && p.trim()).join('\n\n');

function normGoal(g, where) {
  const direction = pick(g, 'direction');
  return {
    name: pick(g, 'name', 'title'),
    description: joinText(
      pick(g, 'description', 'desc'),
      pick(g, 'notes', 'note'),
      pick(g, 'draft') ? 'Draft: target not confirmed yet.' : '',
    ),
    kpi: pick(g, 'kpi', 'KPI', 'metric') ?? '',
    unit: pick(g, 'unit'),
    direction: direction === undefined ? undefined : String(direction).toLowerCase().replace(/ is better$/, ''),
    baseline: pick(g, 'baseline', 'start_value', 'startValue'),
    target: pick(g, 'target', 'target_value', 'targetValue'),
    startDate: pick(g, 'startDate', 'start_date', 'start'),
    dueDate: pick(g, 'dueDate', 'due_date', 'due', 'end', 'endDate', 'end_date'),
    milestones: (g.milestones || []).map(normMilestone),
    touchpoints: (g.touchpoints || []).map(normTouchpoint),
    where,
  };
}

function normMilestone(m) {
  const done = Boolean(pick(m, 'done', 'completed', 'complete'));
  return {
    name: pick(m, 'name', 'title'),
    date: pick(m, 'date', 'due', 'dueDate', 'due_date'),
    done,
    completedOn: done ? pick(m, 'completedOn', 'completed_on', 'completedAt') ?? null : null,
  };
}

function normTouchpoint(t) {
  return {
    date: pick(t, 'date'),
    value: pick(t, 'value', 'current'),
    note: pick(t, 'note', 'notes', 'comment') ?? '',
  };
}

/** Turn either accepted plan shape into nested lanes → goals → milestones/touchpoints. */
export function normalizePlan(raw) {
  if (!raw || !Array.isArray(raw.lanes)) throw new ValidationError('plan.json must have a "lanes" array');
  const lanes = raw.lanes.map((l, i) => {
    const name = typeof l === 'string' ? l : pick(l, 'name', 'title');
    return {
      name,
      color: (typeof l === 'object' && pick(l, 'color', 'colour')) || PALETTE[i % PALETTE.length],
      order: (typeof l === 'object' && pick(l, 'order', 'sort_order')) ?? i,
      company: (typeof l === 'object' && pick(l, 'company')) || null,
      goals: ((typeof l === 'object' && l.goals) || []).map((g) => normGoal(g, `lane "${name}"`)),
    };
  });
  const laneByName = new Map(lanes.map((l) => [String(l.name).toLowerCase(), l]));

  for (const g of raw.goals || []) {
    const laneName = pick(g, 'lane', 'laneName', 'lane_name');
    const lane = laneByName.get(String(laneName).toLowerCase());
    if (!lane) throw new ValidationError(`goal "${g.name}": unknown lane "${laneName}"`);
    lane.goals.push(normGoal(g, `lane "${lane.name}"`));
  }

  const allGoals = lanes.flatMap((l) => l.goals.map((g) => ({ lane: l, goal: g })));
  const findGoal = (item, kind) => {
    const goalName = String(pick(item, 'goal', 'goalName', 'goal_name')).toLowerCase();
    const laneName = pick(item, 'lane');
    const matches = allGoals.filter(
      ({ lane, goal }) =>
        String(goal.name).toLowerCase() === goalName && (!laneName || String(lane.name).toLowerCase() === String(laneName).toLowerCase()),
    );
    if (matches.length !== 1) {
      throw new ValidationError(
        `${kind} "${item.name ?? item.date}": ${matches.length ? 'ambiguous' : 'unknown'} goal "${item.goal}"${matches.length ? ' (add "lane" to disambiguate)' : ''}`,
      );
    }
    return matches[0].goal;
  };
  for (const m of raw.milestones || []) findGoal(m, 'milestone').milestones.push(normMilestone(m));
  for (const t of raw.touchpoints || []) findGoal(t, 'touchpoint').touchpoints.push(normTouchpoint(t));

  return { lanes };
}

/** Validate the whole plan up front so a bad file loads nothing. */
function validatePlan(plan) {
  const wrap = (where, fn) => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof ValidationError) throw new ValidationError(`${where}: ${e.message}`);
      throw e;
    }
  };
  return plan.lanes.map((l) => ({
    company: l.company ? wrap(`lane "${l.name}"`, () => validate('companies', { name: l.company }).name) : null,
    row: wrap(`lane "${l.name}"`, () => validate('lanes', { name: l.name, color: l.color, order: l.order})),
    goals: l.goals.map((g) => {
      const where = `${g.where}, goal "${g.name}"`;
      const row = wrap(where, () => validate('goals', { ...g, laneId: 1 }));
      if (row.due_date < row.start_date) throw new ValidationError(`${where}: dueDate is before startDate`);
      delete row.lane_id;
      return {
        row,
        milestones: g.milestones.map((m) => wrap(`${where}, milestone "${m.name}"`, () => validate('milestones', { ...m, goalId: 1 }))),
        touchpoints: g.touchpoints.map((t) => wrap(`${where}, touchpoint ${t.date}`, () => validate('touchpoints', { ...t, goalId: 1 }))),
      };
    }),
  }));
}

async function insert(client, table, row) {
  const cols = Object.keys(row);
  const { rows } = await client.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    Object.values(row),
  );
  return rows[0].id;
}

/** Load a plan into the database in one transaction. Returns counts. */
export async function seed(pool, raw, { reset = false } = {}) {
  const lanes = validatePlan(normalizePlan(raw));
  const client = await pool.connect();
  const counts = { lanes: 0, goals: 0, milestones: 0, touchpoints: 0 };
  try {
    await client.query('BEGIN');
    if (reset) await client.query('TRUNCATE companies, lanes, goals, milestones, touchpoints RESTART IDENTITY CASCADE');
    const companyIds = new Map();
    for (const lane of lanes) {
      if (lane.company && !companyIds.has(lane.company.toLowerCase())) {
        companyIds.set(lane.company.toLowerCase(), await insert(client, 'companies', { name: lane.company }));
      }
      const laneId = await insert(client, 'lanes', {
        ...lane.row,
        ...(lane.company ? { company_id: companyIds.get(lane.company.toLowerCase()) } : {}),
      });
      counts.lanes++;
      for (const goal of lane.goals) {
        const goalId = await insert(client, 'goals', { ...goal.row, lane_id: laneId });
        counts.goals++;
        for (const m of goal.milestones) {
          if (m.done && !m.completed_on) m.completed_on = m.date;
          await insert(client, 'milestones', { ...m, goal_id: goalId });
          counts.milestones++;
        }
        for (const t of goal.touchpoints) {
          await insert(client, 'touchpoints', { ...t, goal_id: goalId });
          counts.touchpoints++;
        }
      }
    }
    await client.query('COMMIT');
    return counts;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function isEmpty(pool) {
  const { rows } = await pool.query('SELECT NOT EXISTS (SELECT 1 FROM lanes) AS empty');
  return rows[0].empty;
}

export function readPlanFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const reset = args.includes('--reset');
  const file = args.find((a) => !a.startsWith('--')) || process.env.SEED_FILE || 'plan.json';
  const pool = createPool();
  try {
    await migrate(pool);
    if (!reset && !(await isEmpty(pool))) {
      console.error('Database already has data. Re-run with --reset to replace it.');
      process.exitCode = 1;
    } else {
      const counts = await seed(pool, readPlanFile(file), { reset });
      console.log(`Seeded from ${file}:`, counts);
    }
  } catch (e) {
    console.error(e instanceof ValidationError ? `Invalid plan: ${e.message}` : e);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
