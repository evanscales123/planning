import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizePlan } from '../seed.js';

test('example plan normalizes: nested and flat shapes merge', () => {
  const plan = normalizePlan(JSON.parse(fs.readFileSync(new URL('../plan.example.json', import.meta.url))));
  assert.deepEqual(plan.lanes.map((l) => l.name), ['Consulting', 'Product']);
  const product = plan.lanes[1];
  assert.deepEqual(product.goals.map((g) => g.name), ['Launch v2', 'Beta']);
  assert.equal(product.goals[0].milestones.length, 2);
  assert.equal(product.goals[0].touchpoints[0].value, 38);
  assert.ok(product.color.startsWith('#'));
});

test('aliases and errors', () => {
  const plan = normalizePlan({
    lanes: ['Ops'],
    goals: [{ lane: 'ops', title: 'Cut churn', start: '2026-01-01', due: '2026-06-01', baseline: 5, target: 3, direction: 'Lower is better', unit: '%' }],
  });
  const g = plan.lanes[0].goals[0];
  assert.equal(g.name, 'Cut churn');
  assert.equal(g.direction, 'lower');
  assert.equal(g.dueDate, '2026-06-01');
  assert.throws(() => normalizePlan({ lanes: [], goals: [{ lane: 'Nope', name: 'x' }] }), /unknown lane/);
  assert.throws(() => normalizePlan({ lanes: ['A'], milestones: [{ goal: 'x', name: 'm' }] }), /unknown goal/);
});

test('lanes can name a company; null baselines and draft notes survive', () => {
  const plan = normalizePlan({
    lanes: [
      { name: 'Studio', company: 'Acme Co', goals: [{ name: 'Hold burn', kpi: 'Burn', unit: '$', direction: 'lower', baseline: null, target: null, start: '2026-01-01', due: '2026-12-31', draft: true, notes: 'Set later.' }] },
      { name: 'Personal' },
    ],
  });
  assert.deepEqual(plan.lanes.map((l) => l.company), ['Acme Co', null]);
  const g = plan.lanes[0].goals[0];
  assert.equal(g.baseline, undefined);
  assert.match(g.description, /Set later\.\n\nDraft: target not confirmed/);
});
