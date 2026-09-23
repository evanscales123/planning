// Derived goal metrics. Nothing here is stored; everything is computed from
// the goal, its touchpoints and "today". Shared by the browser and the tests.

export const STALE_DAYS = 120;
export const PACE_BAND = 0.1; // on pace if |gap| <= 10% of |target - baseline|

const DAY_MS = 86400000;
const EPS = 1e-9;

const pad = (n) => String(n).padStart(2, '0');

/** Day number (days since epoch) for an ISO date string YYYY-MM-DD. */
export function toDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

/** Today's date in the viewer's local timezone, as YYYY-MM-DD. */
export function localToday(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function daysBetween(from, to) {
  return toDay(to) - toDay(from);
}

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Fraction of the goal's time window elapsed at `today`, clamped to [0, 1]. */
export function elapsedFraction(goal, today) {
  const s = toDay(goal.startDate);
  const d = toDay(goal.dueDate);
  const t = toDay(today);
  if (d <= s) return t >= d ? 1 : 0;
  return clamp((t - s) / (d - s), 0, 1);
}

/** baseline + (target − baseline) × clamp((today − start) / (due − start), 0, 1) */
export function expectedAt(goal, today) {
  return goal.baseline + (goal.target - goal.baseline) * elapsedFraction(goal, today);
}

/** Latest touchpoint by date; ties go to the one logged last (higher id). */
export function latestTouchpoint(touchpoints) {
  let best = null;
  for (const tp of touchpoints) {
    if (!best || tp.date > best.date || (tp.date === best.date && tp.id > best.id)) best = tp;
  }
  return best;
}

/** 'active' (start ≤ today < due), 'ahead' (start > today) or 'past' (due ≤ today). */
export function phaseOf(goal, today) {
  if (today >= goal.dueDate) return 'past';
  if (goal.startDate <= today) return 'active';
  return 'ahead';
}

export function isReached(goal, value) {
  return goal.direction === 'lower' ? value <= goal.target + EPS : value >= goal.target - EPS;
}

/** 'on' | 'ahead' | 'behind', honoring the goal's direction. */
export function paceOf(goal, gap) {
  const band = PACE_BAND * Math.abs(goal.target - goal.baseline);
  if (Math.abs(gap) <= band + EPS) return 'on';
  const better = goal.direction === 'lower' ? gap < 0 : gap > 0;
  return better ? 'ahead' : 'behind';
}

/** How far from baseline toward target a value is, clamped to [0, 1]. */
export function progressOf(goal, value) {
  const span = goal.target - goal.baseline;
  if (Math.abs(span) < EPS) return isReached(goal, value) ? 1 : 0;
  return clamp((value - goal.baseline) / span, 0, 1);
}

export const PACE_LABEL = { on: 'On pace', ahead: 'Ahead', behind: 'Behind' };

/**
 * Everything the UI shows about a goal that isn't stored.
 * status precedence: No touchpoint → Reached → Overdue → Stale → In progress.
 */
export function deriveGoal(goal, touchpoints, today) {
  const phase = phaseOf(goal, today);
  const expectedToday = expectedAt(goal, today);
  const latest = latestTouchpoint(touchpoints);
  const base = { phase, expectedToday, expectedProgress: elapsedFraction(goal, today) };
  if (!latest) {
    return { ...base, latest: null, current: null, gap: null, pace: null, progress: 0, status: 'No touchpoint' };
  }
  const current = latest.value;
  const gap = current - expectedToday;
  let status = 'In progress';
  if (isReached(goal, current)) status = 'Reached';
  else if (today > goal.dueDate) status = 'Overdue';
  else if (daysBetween(latest.date, today) > STALE_DAYS) status = 'Stale';
  return {
    ...base,
    latest,
    current,
    gap,
    pace: paceOf(goal, gap),
    progress: progressOf(goal, current),
    status,
  };
}

export function sortMilestones(milestones) {
  return [...milestones].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
}

export function nextOpenMilestone(milestones) {
  return sortMilestones(milestones).find((m) => !m.done) || null;
}

export function byDue(a, b) {
  return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : a.id - b.id;
}

/**
 * Split a lane's goals into the three bands of a column, each sorted by due date:
 * active (above the today line), ahead (below it) and past (collapsed at the bottom).
 * `current` is the goal the header strip features: the soonest-due active goal,
 * or failing that the next one ahead.
 */
export function laneBands(goals, today) {
  const sorted = [...goals].sort(byDue);
  const bands = { active: [], ahead: [], past: [] };
  for (const g of sorted) bands[phaseOf(g, today)].push(g);
  return { ...bands, current: bands.active[0] || bands.ahead[0] || null };
}
