import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveGoal, expectedAt, laneBands, nextOpenMilestone, paceOf, phaseOf } from '../public/derive.js';

const goal = (o = {}) => ({
  id: 1, kpi: 'Widgets', unit: 'count', baseline: 0, target: 100, direction: 'higher',
  startDate: '2026-01-01', dueDate: '2026-12-31', ...o,
});

test('expectedToday interpolates and clamps', () => {
  const g = goal({ startDate: '2026-01-01', dueDate: '2026-01-11' });
  assert.equal(expectedAt(g, '2025-12-01'), 0);
  assert.equal(expectedAt(g, '2026-01-06'), 50);
  assert.equal(expectedAt(g, '2027-01-01'), 100);
  assert.equal(expectedAt(goal({ baseline: 40, target: 20, startDate: '2026-01-01', dueDate: '2026-01-11' }), '2026-01-06'), 30);
});

test('pace honors the 10% band and direction', () => {
  assert.equal(paceOf(goal(), 10), 'on');
  assert.equal(paceOf(goal(), -10), 'on');
  assert.equal(paceOf(goal(), 10.5), 'ahead');
  assert.equal(paceOf(goal(), -11), 'behind');
  const lower = goal({ baseline: 50, target: 30, direction: 'lower' }); // band = 2
  assert.equal(paceOf(lower, -3), 'ahead');
  assert.equal(paceOf(lower, 3), 'behind');
  assert.equal(paceOf(lower, 2), 'on');
});

test('current is the latest touchpoint, ties broken by id', () => {
  const tps = [
    { id: 1, date: '2026-03-01', value: 10 },
    { id: 3, date: '2026-05-01', value: 30 },
    { id: 2, date: '2026-05-01', value: 20 },
  ];
  const d = deriveGoal(goal(), tps, '2026-06-01');
  assert.equal(d.current, 30);
  assert.ok(Math.abs(d.gap - (30 - expectedAt(goal(), '2026-06-01'))) < 1e-9);
});

test('status precedence', () => {
  const today = '2026-07-01';
  assert.equal(deriveGoal(goal(), [], today).status, 'No touchpoint');
  assert.equal(deriveGoal(goal(), [{ id: 1, date: '2026-06-01', value: 100 }], today).status, 'Reached');
  assert.equal(deriveGoal(goal({ dueDate: '2026-06-30' }), [{ id: 1, date: '2026-06-29', value: 50 }], today).status, 'Overdue');
  assert.equal(deriveGoal(goal({ dueDate: '2026-07-01' }), [{ id: 1, date: '2026-06-29', value: 50 }], today).status, 'In progress');
  assert.equal(deriveGoal(goal(), [{ id: 1, date: '2026-03-01', value: 50 }], today).status, 'Stale'); // 122 days
  assert.equal(deriveGoal(goal(), [{ id: 1, date: '2026-03-03', value: 50 }], today).status, 'In progress'); // 120 days
  const lower = goal({ baseline: 50, target: 30, direction: 'lower' });
  assert.equal(deriveGoal(lower, [{ id: 1, date: '2026-06-01', value: 29 }], today).status, 'Reached');
});

test('phases and lane bands', () => {
  const t = '2026-06-01';
  assert.equal(phaseOf(goal({ startDate: '2026-06-01', dueDate: '2026-07-01' }), t), 'active');
  assert.equal(phaseOf(goal({ startDate: '2026-05-01', dueDate: '2026-06-01' }), t), 'past');
  assert.equal(phaseOf(goal({ startDate: '2026-06-02', dueDate: '2026-07-01' }), t), 'ahead');
  const gs = [
    goal({ id: 1, startDate: '2026-07-01', dueDate: '2026-12-01' }),
    goal({ id: 2, startDate: '2026-01-01', dueDate: '2026-09-01' }),
    goal({ id: 3, startDate: '2025-01-01', dueDate: '2026-03-01' }),
    goal({ id: 4, startDate: '2026-08-01', dueDate: '2026-10-01' }),
  ];
  const b = laneBands(gs, t);
  assert.deepEqual(b.active.map((g) => g.id), [2]);
  assert.deepEqual(b.ahead.map((g) => g.id), [4, 1]);
  assert.deepEqual(b.past.map((g) => g.id), [3]);
  assert.equal(b.current.id, 2);
  assert.equal(laneBands([gs[0]], t).current.id, 1); // falls back to next ahead
});

test('next open milestone is the earliest unchecked', () => {
  const ms = [
    { id: 1, date: '2026-05-01', done: true },
    { id: 2, date: '2026-09-01', done: false },
    { id: 3, date: '2026-07-01', done: false },
  ];
  assert.equal(nextOpenMilestone(ms).id, 3);
  assert.equal(nextOpenMilestone([ms[0]]), null);
});

test('unset baseline comes from the first touchpoint; unset target means no pace', () => {
  const today = '2026-07-01';
  const tps = [{ id: 2, date: '2026-06-01', value: 70 }, { id: 1, date: '2026-02-01', value: 20 }];
  const d = deriveGoal(goal({ baseline: null }), tps, today);
  assert.equal(d.baseline, 20);
  assert.ok(d.expectedToday > 20 && d.expectedToday < 100);
  assert.ok(d.pace);
  const noTarget = deriveGoal(goal({ target: null }), tps, today);
  assert.equal(noTarget.pace, null);
  assert.equal(noTarget.gap, null);
  assert.equal(noTarget.status, 'In progress');
  assert.equal(deriveGoal(goal({ baseline: null, target: null }), [], today).status, 'No touchpoint');
});

test('goals without a KPI track milestones instead', () => {
  const g = goal({ kpi: '', unit: null, baseline: null, target: null, dueDate: '2026-12-31' });
  const ms = [{ id: 1, done: true }, { id: 2, done: false }];
  const d = deriveGoal(g, [], '2026-07-01', ms);
  assert.equal(d.kpi, false);
  assert.equal(d.status, 'In progress');
  assert.equal(d.progress, 0.5);
  assert.equal(d.pace, null);
  assert.equal(deriveGoal(g, [], '2027-01-05', ms).status, 'Overdue');
  assert.equal(deriveGoal(g, [], '2027-01-05', [{ id: 1, done: true }]).status, 'Done');
});
