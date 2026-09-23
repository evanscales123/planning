import {
  deriveGoal,
  laneBands,
  localToday,
  nextOpenMilestone,
  sortMilestones,
  daysBetween,
  PACE_LABEL,
  hasKpi,
} from './derive.js';

const UNITS = ['$', '%', 'count', 'days', 'weeks', 'score'];
const LANE_COLORS = ['#4f6d8f', '#8a6d3b', '#5b7f5b', '#8f4f6d', '#6d5b8f', '#3b7f7f', '#8f6d4f'];

let state = { companies: [], lanes: [], goals: [], milestones: [], touchpoints: [] };
const openPast = new Set(); // lane ids whose "Past" section is expanded
const today = () => localToday();

const $ = (sel, root = document) => root.querySelector(sel);
const board = $('#board');
const indexNav = $('#index');
const modal = $('#modal');
const modalForm = $('#modal-form');

// ---- helpers --------------------------------------------------------------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(iso, { withYear } = {}) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  const showYear = withYear ?? y !== Number(today().slice(0, 4));
  return `${MONTHS[m - 1]} ${d}${showYear ? `, ${y}` : ''}`;
}

/** "Due in 3 years", "Due in 5 months", "Due in 2 weeks", "Due today", "Due 3 weeks ago". */
function dueLabel(iso) {
  const n = daysBetween(today(), iso);
  if (n === 0) return 'Due today';
  if (n === 1) return 'Due tomorrow';
  if (n === -1) return 'Due yesterday';
  const d = Math.abs(n);
  const plural = (v, unit) => `${v} ${unit}${v === 1 ? '' : 's'}`;
  const span =
    d < 14 ? plural(d, 'day') : d < 60 ? plural(Math.round(d / 7), 'week') : d < 730 ? plural(Math.round(d / 30.44), 'month') : plural(Math.round(d / 365.25), 'year');
  return n > 0 ? `Due in ${span}` : `Due ${span} ago`;
}

function relDays(iso) {
  const n = daysBetween(today(), iso);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  if (n > 0) return n < 60 ? `in ${n} d` : `in ${Math.round(n / 7)} wk`;
  return -n < 60 ? `${-n} d late` : `${Math.round(-n / 7)} wk late`;
}

function trimNum(n, digits) {
  return Number(n.toFixed(digits)).toLocaleString('en-US', { maximumFractionDigits: digits });
}

function fmtVal(v, unit) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const abs = Math.abs(v);
  switch (unit) {
    case '$':
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        notation: abs >= 100000 ? 'compact' : 'standard',
        maximumFractionDigits: abs >= 100000 ? 1 : abs < 100 ? 2 : 0,
        minimumFractionDigits: 0,
      }).format(v);
    case '%':
      return `${trimNum(v, 1)}%`;
    case 'days':
      return `${trimNum(v, 1)} d`;
    case 'weeks':
      return `${trimNum(v, 1)} wk`;
    case 'score':
      return trimNum(v, 2);
    default:
      return abs >= 100000
        ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v)
        : trimNum(v, 2);
  }
}
const fmtSigned = (v, unit) => (v > 0 ? '+' : v < 0 ? '−' : '±') + fmtVal(Math.abs(v), unit);

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

async function api(method, url, body) {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('Signed out');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

function upsert(table, row) {
  const list = state[table];
  const i = list.findIndex((r) => r.id === row.id);
  if (i >= 0) list[i] = row;
  else list.push(row);
}

function removeRow(table, id) {
  state[table] = state[table].filter((r) => r.id !== id);
}

const byId = (table, id) => state[table].find((r) => r.id === Number(id));
const companiesSorted = () => [...state.companies].sort((a, b) => a.name.localeCompare(b.name));
const lanesSorted = () => [...state.lanes].sort((a, b) => a.order - b.order || a.id - b.id);

// ---- rendering ------------------------------------------------------------

function laneColorStyle(lane) {
  return `--lane:${esc(lane.color)}`;
}

const goalMilestones = (goalId) => state.milestones.filter((m) => m.goalId === goalId);
const goalTouchpoints = (goalId) => state.touchpoints.filter((t) => t.goalId === goalId);
const deriveFor = (goal) => deriveGoal(goal, goalTouchpoints(goal.id), today(), goalMilestones(goal.id));
const isFinished = (d) => d.status === 'Reached' || d.status === 'Done';

/**
 * Card tint: green once the goal is reached (or, without a KPI, all milestones
 * are done); warm when it needs attention (behind pace, overdue, stale); else none.
 */
function tone(d) {
  if (d.status === 'Reached' || d.status === 'Done') return 'good';
  if (d.pace === 'behind' || d.status === 'Overdue' || d.status === 'Stale') return 'warn';
  return '';
}

function todayLong() {
  return new Date(`${today()}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

/** What the header roundup counts a goal under (only goals that have started). */
function flagsOf(goal, d) {
  if (d.phase === 'ahead') return [];
  const flags = [];
  if (d.status === 'Overdue') flags.push('overdue');
  else if (d.pace === 'behind') flags.push('behind');
  if (d.status === 'Stale') flags.push('stale');
  if (goalMilestones(goal.id).some((m) => !m.done && m.date < today())) flags.push('late-ms');
  return flags;
}

/** The short status line next to today's date; each count jumps to its first card. */
function renderRoundup() {
  const counts = { behind: 0, overdue: 0, stale: 0 };
  for (const g of state.goals) for (const f of flagsOf(g, deriveFor(g))) if (f in counts) counts[f]++;
  const lateMs = state.milestones.filter((m) => !m.done && m.date < today()).length;
  const items = [
    ['behind', counts.behind, (n) => `${n} goal${n === 1 ? '' : 's'} behind`],
    ['overdue', counts.overdue, (n) => `${n} overdue`],
    ['stale', counts.stale, (n) => `${n} stale`],
    ['late-ms', lateMs, (n) => `${n} milestone${n === 1 ? '' : 's'} past due`],
  ].filter(([, n]) => n);
  $('#roundup').innerHTML = items.length
    ? items.map(([kind, n, label]) => `<button class="chip" data-action="jump" data-kind="${kind}">${label(n)}</button>`).join('')
    : `<span class="chip ok">All on track</span>`;
}

/** ↑ or ↓ after the KPI label: which way is better. */
function directionArrow(goal) {
  const lower = goal.direction === 'lower';
  const label = lower ? 'Lower is better' : 'Higher is better';
  return `<span class="dir" title="${label}" aria-label="${label}">${lower ? '↓' : '↑'}</span>`;
}

function paceChip(goal, d) {
  // Reached (or all milestones done) replaces the pace: it's one or the other.
  if (d.status === 'Reached' || d.status === 'Done') return `<span class="pace reached">${d.status}</span>`;
  if (d.phase === 'ahead' && d.current === null) return '';
  if (!d.kpi) return d.total ? `<span class="pace none">${d.done} of ${d.total}</span>` : '';
  if (d.pace) return `<span class="pace ${d.pace}" title="Expected today ${esc(fmtVal(d.expectedToday, goal.unit))}">${PACE_LABEL[d.pace]}</span>`;
  if (goal.target === null && d.current !== null) return `<span class="pace none">No target</span>`;
  return `<span class="pace none">No data</span>`;
}

/**
 * The Today panel at the top of a lane: the current goal and the next unchecked
 * milestone. If the current goal has no open milestones, the earliest open one
 * from the lane's other active goals is shown, labelled with its goal.
 */
function todayHTML(lane, bands, { rule = true } = {}) {
  const current = bands.current;
  const head = rule ? `<div class="today-rule bare"></div>` : '';
  if (!current) {
    return `<div class="today" style="${laneColorStyle(lane)}">${head}<div class="today-body"><span class="none">Nothing active</span></div></div>`;
  }
  let next = nextOpenMilestone(goalMilestones(current.id));
  if (!next) {
    const others = bands.active.filter((g) => g.id !== current.id).flatMap((g) => goalMilestones(g.id));
    next = nextOpenMilestone(others);
  }
  const fromOther = next && next.goalId !== current.id ? byId('goals', next.goalId) : null;
  const upcoming = current.startDate > today();
  const d = deriveFor(current);
  const nextHTML = next
    ? `<div class="next"><label><input type="checkbox" data-action="toggle-ms" data-id="${next.id}">
         <span class="ms"><span class="name">${esc(next.name)}${fromOther ? ` <small>· ${esc(fromOther.name)}</small>` : ''}</span>
         <time datetime="${next.date}" title="${fmtDate(next.date, { withYear: true })}" class="${next.date < today() ? 'late' : ''}">${fmtDate(next.date)} · ${relDays(next.date)}</time></span></label></div>`
    : `<div class="next none">No open milestones</div>`;
  return `<div class="today" style="${laneColorStyle(lane)}">${head}
      <div class="today-body ${tone(d)}">
        <div class="goal-line">
          <span class="goal-name" title="${esc(current.name)}">${upcoming ? '<small>Starts ' + fmtDate(current.startDate) + ' · </small>' : ''}${esc(current.name)}</span>
          ${paceChip(current, d)}
        </div>
        ${nextHTML}
        ${moreActiveHTML(bands, current)}
      </div>
    </div>`;
}

/** A reminder that the lane has other goals running besides the one featured. */
function moreActiveHTML(bands, current) {
  const others = bands.active.filter((g) => g.id !== current.id);
  if (!others.length) return '';
  const n = others.length;
  return `<button class="more-active" data-action="jump-goal" data-ids="${others.map((g) => g.id).join(' ')}"
      title="${esc(others.map((g) => g.name).join('\n'))}">+ ${n} more active goal${n === 1 ? '' : 's'}</button>`;
}

function cardHTML(goal, lane) {
  const t = today();
  const d = deriveFor(goal);
  const ms = sortMilestones(goalMilestones(goal.id));
  const statusClass = d.status.replace(/\s+/g, '-');
  const notStarted = d.phase === 'ahead' && d.current === null;
  const finished = isFinished(d);
  const meta = [
    notStarted
      ? `<span class="status">Starts ${fmtDate(goal.startDate)}</span>`
      : finished
        ? ''
        : `<span class="status ${statusClass}">${d.status}</span>`,
    d.gap !== null && !finished ? `<span title="Current minus expected today (${esc(fmtVal(d.expectedToday, goal.unit))})">${fmtSigned(d.gap, goal.unit)} vs pace</span>` : '',
    d.latest ? `<span title="${esc(d.latest.note)}">Last ${fmtDate(d.latest.date)}</span>` : '',
  ].join('');
  const milestones = ms.length
    ? `<ul class="milestones">${ms
        .map(
          (m) => `<li class="${m.done ? 'done' : ''} ${m.date < t ? 'late' : ''}">
            <label><input type="checkbox" data-action="toggle-ms" data-id="${m.id}" ${m.done ? 'checked' : ''}>
            <span class="name">${esc(m.name)}</span></label>
            <time datetime="${m.date}" title="${m.done && m.completedOn ? `Done ${fmtDate(m.completedOn, { withYear: true })}` : fmtDate(m.date, { withYear: true })}">${fmtDate(m.date)}</time>
            <button class="del" data-action="del-ms" data-id="${m.id}" title="Delete milestone" aria-label="Delete milestone">×</button>
          </li>`,
        )
        .join('')}</ul>`
    : '';
  const due = `<div><dt>${dueLabel(goal.dueDate)}</dt><dd title="${fmtDate(goal.dueDate, { withYear: true })}">${fmtDate(goal.dueDate)}</dd></div>`;
  const nums = d.kpi
    ? `<div><dt>Current</dt><dd>${
        // Until the first touchpoint, show the baseline as the starting value.
        d.current === null && d.baseline !== null
          ? `<span class="from-baseline" title="Baseline (no touchpoints yet)">${fmtVal(d.baseline, goal.unit)}</span>`
          : fmtVal(d.current, goal.unit)
      }</dd></div>
       <div><dt>Target</dt><dd>${goal.target === null ? '<span class="unset">Not set</span>' : fmtVal(goal.target, goal.unit)}</dd></div>${due}`
    : `<div><dt>Milestones</dt><dd>${d.total ? `${d.done} of ${d.total}` : '—'}</dd></div>
       <div><dt>Starts</dt><dd>${fmtDate(goal.startDate)}</dd></div>${due}`;
  const barTitle = d.kpi
    ? `Progress from ${esc(fmtVal(d.baseline, goal.unit))}; the tick marks where today's pace expects you`
    : `Milestones checked; the tick marks how much of the time window has passed`;
  const showTick = d.phase !== 'ahead' && (!d.kpi || d.expectedToday !== null);
  return `<article class="card ${isFinished(d) ? 'finished' : d.phase} ${tone(d)}" style="${laneColorStyle(lane)}" data-goal="${goal.id}" data-flags="${flagsOf(goal, d).join(' ')}">
      <div class="card-head">
        <h3><button data-action="edit-goal" data-id="${goal.id}" title="${esc(goal.description || 'Edit goal')}">${esc(goal.name)}</button></h3>
        ${paceChip(goal, d)}
      </div>
      ${d.kpi ? `<div class="kpi">${esc(goal.kpi)} ${directionArrow(goal)}</div>` : ''}
      <dl class="nums">${nums}</dl>
      <div class="bar" title="${barTitle}">
        <span class="fill" style="width:${(d.progress * 100).toFixed(1)}%"></span>
        ${showTick ? `<span class="tick" style="left:${(d.expectedProgress * 100).toFixed(1)}%"></span>` : ''}
      </div>
      <div class="meta">${meta}</div>
      ${milestones}
      <div class="card-foot">
        ${d.kpi ? `<button data-action="log-tp" data-goal="${goal.id}">Log touchpoint</button>` : ''}
        <button data-action="add-ms" data-goal="${goal.id}">+ Milestone</button>
      </div>
    </article>`;
}

/**
 * The board is a grid: one column per lane, one row per time band shared by
 * every lane — the Today heads, Now, then one row per due year, then Past — so
 * a given year starts at the same height in every column. Cells are emitted
 * lane by lane, which is also the order they stack in on mobile.
 */
function render() {
  const t = today();
  $('#today-label').textContent = todayLong();
  renderRoundup();
  const lanes = lanesSorted();
  if (!lanes.length) {
    board.innerHTML = `<p class="empty">No lanes yet.<br><br><button data-action="add-lane">+ Add a lane</button></p>`;
    indexNav.innerHTML = '';
    return;
  }
  const perLane = lanes.map((lane) => ({
    lane,
    bands: laneBands(state.goals.filter((g) => g.laneId === lane.id), t, (g) => isFinished(deriveFor(g))),
  }));
  const thisYear = t.slice(0, 4);
  const years = [...new Set(perLane.flatMap(({ bands }) => bands.ahead.map((g) => g.dueDate.slice(0, 4))))]
    .filter((y) => y > thisYear)
    .sort();
  const rows = ['now', ...years, 'past'];
  const hasPast = perLane.some(({ bands }) => bands.past.length);

  board.style.setProperty('--lanes', lanes.length);
  const anyCompany = lanes.some((l) => byId('companies', l.companyId));
  const cells = [];
  const index = [];
  perLane.forEach(({ lane, bands }, col) => {
    const at = (row) => `grid-column:${col + 2};grid-row:${row + 1}`;
    const style = laneColorStyle(lane);
    const title = `<div class="lane-title"><span class="dot" style="${style}"></span>
        <h2><button data-action="edit-lane" data-id="${lane.id}" title="Edit lane">${esc(lane.name)}</button></h2>
        <button class="add" data-action="add-goal" data-lane="${lane.id}" title="Add goal to ${esc(lane.name)}">+ Goal</button></div>`;
    const company = byId('companies', lane.companyId);
    const eyebrow = anyCompany ? `<div class="eyebrow">${company ? esc(company.name) : ''}</div>` : '';
    index.push(`<a href="#lane-${lane.id}">${company ? `<div class="eyebrow">${esc(company.name)}</div>` : ''}<div class="lane-title"><span class="dot" style="${style}"></span><h2>${esc(lane.name)}</h2></div>${todayHTML(lane, bands, { rule: false })}</a>`);
    cells.push(`<div class="lane-head ${col < lanes.length - 1 ? 'has-next' : ''}" id="lane-${lane.id}" style="${style};${at(0)}">${eyebrow}${title}${todayHTML(lane, bands)}</div>`);

    const empty = !bands.active.length && !bands.finished.length && !bands.ahead.length && !bands.past.length;
    rows.forEach((row, i) => {
      let label = '';
      let goals = [];
      let body = '';
      if (row === 'now') {
        // The current year: everything active now, plus goals starting later but due this year.
        label = thisYear;
        goals = [...bands.active, ...bands.finished, ...bands.ahead.filter((g) => g.dueDate.slice(0, 4) <= thisYear)];
        if (empty) body = `<p class="empty-lane">No goals yet.</p>`;
      } else if (row === 'past') {
        if (!hasPast) return;
        if (bands.past.length) {
          body = `<details class="past" data-lane="${lane.id}" ${openPast.has(lane.id) ? 'open' : ''}>
              <summary>Past · ${bands.past.length}</summary>
              <div class="stack">${bands.past.map((g) => cardHTML(g, lane)).join('')}</div>
            </details>`;
        }
      } else {
        label = row;
        goals = bands.ahead.filter((g) => g.dueDate.startsWith(row));
      }
      body = goals.map((g) => cardHTML(g, lane)).join('') + body;
      const cls = row === 'now' ? 'now' : row === 'past' ? 'past-cell' : 'year-cell';
      cells.push(`<div class="cell ${cls} ${body ? '' : 'vacant'} ${col < lanes.length - 1 ? 'has-next' : ''}" style="${style};${at(i + 1)}">
          ${label ? `<div class="band-label"><span>${label}</span></div>` : ''}${body}</div>`);
    });
  });
  // Column 1 is a gutter holding one label per row (the year, or Past). Each label
  // sticks under the lane heads while its row scrolls by, then the next row's
  // label takes over. A hairline marks where each row starts, across all lanes.
  const rowCount = 1 + rows.length - (hasPast ? 0 : 1);
  const gutter = [
    `<div class="gutter-bg" style="grid-row:1 / span ${rowCount}"></div>`,
    `<div class="gutter-head" style="grid-column:1;grid-row:1"><span class="gutter-today">Today</span></div>`,
  ];
  rows.forEach((row, i) => {
    if (row === 'past' && !hasPast) return;
    const label = row === 'now' ? thisYear : row === 'past' ? 'Past' : row;
    if (i > 0) gutter.push(`<div class="row-rule" style="grid-row:${i + 2}"></div>`);
    gutter.push(`<div class="gutter-label ${row === 'now' ? 'current' : ''}" style="grid-column:1;grid-row:${i + 2}">${label}</div>`);
  });
  board.innerHTML = gutter.join('') + cells.join('');
  syncHeadHeight();
  indexNav.innerHTML = `<div class="today-rule"><span>Today</span></div>${index.join('')}`;
}

/** Year labels stick just below the lane heads, so they need the heads' height. */
function syncHeadHeight() {
  const head = board.querySelector('.lane-head');
  if (!head) return;
  board.style.setProperty('--head-h', `${head.getBoundingClientRect().height}px`);
  // and the gutter's "Today" label lines up with the top of the Today panels
  const panel = head.querySelector('.today-body');
  if (panel) board.style.setProperty('--today-top', `${panel.getBoundingClientRect().top - head.getBoundingClientRect().top}px`);
}
window.addEventListener('resize', syncHeadHeight);

// ---- modals ---------------------------------------------------------------

let onSubmit = null;

function openModal(html, submit) {
  modalForm.innerHTML = html;
  onSubmit = submit;
  modal.showModal();
  const first = modalForm.querySelector('input:not([type=hidden]):not([type=checkbox]), select, textarea');
  first?.focus();
}

function showError(msg) {
  let el = modalForm.querySelector('.error');
  if (!el) {
    el = document.createElement('p');
    el.className = 'error';
    modalForm.querySelector('.buttons').before(el);
  }
  el.textContent = msg;
}

modalForm.addEventListener('submit', async (e) => {
  const action = e.submitter?.value;
  if (action === 'cancel') return; // default dialog close
  e.preventDefault();
  if (!onSubmit) return;
  const data = Object.fromEntries(new FormData(modalForm));
  const buttons = modalForm.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  try {
    const keepOpen = await onSubmit(data, action);
    if (!keepOpen) modal.close();
    render();
  } catch (err) {
    showError(err.message);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
});

const buttons = (primary, { del } = {}) => `<div class="buttons">
    ${del ? `<button type="submit" value="delete" class="danger" formnovalidate>${del}</button>` : ''}
    <button type="submit" value="cancel" formnovalidate>Cancel</button>
    <button type="submit" value="save" class="primary">${primary}</button>
  </div>`;

const options = (items, selected) =>
  items.map(([v, label]) => `<option value="${esc(v)}" ${String(v) === String(selected) ? 'selected' : ''}>${esc(label)}</option>`).join('');

function goalOptions(selected, { kpiOnly = false } = {}) {
  return lanesSorted()
    .map((lane) => {
      const goals = state.goals
        .filter((g) => g.laneId === lane.id && (!kpiOnly || hasKpi(g)))
        .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
      if (!goals.length) return '';
      return `<optgroup label="${esc(lane.name)}">${options(goals.map((g) => [g.id, g.name]), selected)}</optgroup>`;
    })
    .join('');
}

function laneModal(lane) {
  const lanes = lanesSorted();
  const pos = lane ? lanes.findIndex((l) => l.id === lane.id) : -1;
  const color = lane?.color || LANE_COLORS[state.lanes.length % LANE_COLORS.length];
  openModal(
    `<h2>${lane ? 'Edit lane' : 'New lane'}</h2>
     <label>Name<input name="name" required maxlength="200" value="${esc(lane?.name)}"></label>
     <label>Company<select name="companyId">${options([['', 'None'], ...companiesSorted().map((c) => [c.id, c.name])], lane?.companyId ?? '')}</select></label>
     <p class="hint">Companies are managed in Settings.</p>
     <div class="row">
       <label>Color<input type="color" name="color" value="${esc(color)}"></label>
       ${
         lane
           ? `<label>Position<select name="position">${options(
               lanes.map((_, i) => [i, `${i + 1}${i === pos ? ' (current)' : ''}`]),
               pos,
             )}</select></label>`
           : ''
       }
     </div>
     ${lane ? `<p class="hint">Deleting a lane deletes its goals, milestones and touchpoints.</p>` : ''}
     ${buttons(lane ? 'Save' : 'Add lane', { del: lane && 'Delete lane' })}`,
    async (data, action) => {
      if (action === 'delete') {
        if (!confirm(`Delete lane "${lane.name}" and everything in it?`)) return true;
        await api('DELETE', `/lanes/${lane.id}`);
        const goalIds = new Set(state.goals.filter((g) => g.laneId === lane.id).map((g) => g.id));
        removeRow('lanes', lane.id);
        state.goals = state.goals.filter((g) => !goalIds.has(g.id));
        state.milestones = state.milestones.filter((m) => !goalIds.has(m.goalId));
        state.touchpoints = state.touchpoints.filter((t) => !goalIds.has(t.goalId));
        return;
      }
      const body = { name: data.name, color: data.color, companyId: data.companyId ? Number(data.companyId) : null };
      if (!lane) {
        upsert('lanes', await api('POST', '/lanes', body));
        return;
      }
      upsert('lanes', await api('PATCH', `/lanes/${lane.id}`, body));
      const newPos = Number(data.position);
      if (newPos !== pos) {
        const ids = lanesSorted().map((l) => l.id).filter((id) => id !== lane.id);
        ids.splice(newPos, 0, lane.id);
        await api('PUT', '/lanes-order', { ids });
        ids.forEach((id, i) => (byId('lanes', id).order = i + 1));
      }
    },
  );
}

/** Settings: the list of companies lanes can belong to. */
function settingsModal() {
  const rowsHTML = () =>
    companiesSorted()
      .map((c) => {
        const n = state.lanes.filter((l) => l.companyId === c.id).length;
        return `<li><input name="company-${c.id}" value="${esc(c.name)}" required maxlength="200" aria-label="Company name">
          <span class="count">${n} lane${n === 1 ? '' : 's'}</span>
          <button type="button" class="del" data-action="del-company" data-id="${c.id}" title="Delete company" aria-label="Delete ${esc(c.name)}">×</button></li>`;
      })
      .join('') || `<li class="none">No companies yet.</li>`;
  openModal(
    `<h2>Settings</h2>
     <h3 class="section">Companies</h3>
     <p class="hint">Lanes can belong to a company; it shows above the lane name. Assign one when editing a lane.</p>
     <ul class="companies" id="company-list">${rowsHTML()}</ul>
     <label>Add a company<input name="newCompany" maxlength="200" placeholder="Company name"></label>
     ${buttons('Save')}`,
    async (data) => {
      for (const c of state.companies) {
        const name = (data[`company-${c.id}`] ?? '').trim();
        if (name && name !== c.name) upsert('companies', await api('PATCH', `/companies/${c.id}`, { name }));
      }
      const added = (data.newCompany || '').trim();
      if (added) upsert('companies', await api('POST', '/companies', { name: added }));
    },
  );
  modalForm.refreshHistory = () => ($('#company-list').innerHTML = rowsHTML());
}

function goalModal(goal, laneId) {
  if (!state.lanes.length) return laneModal();
  const g = goal || {
    laneId: laneId || lanesSorted()[0].id,
    kpi: '',
    unit: 'count',
    direction: 'higher',
    startDate: today(),
  };
  const tracksKpi = Boolean(g.kpi) || !goal;
  openModal(
    `<h2>${goal ? 'Edit goal' : 'New goal'}</h2>
     <label>Lane<select name="laneId">${options(lanesSorted().map((l) => [l.id, l.name]), g.laneId)}</select></label>
     <label>Name<input name="name" required maxlength="200" value="${esc(g.name)}"></label>
     <label>Description<textarea name="description" rows="2" maxlength="5000">${esc(g.description)}</textarea></label>
     <label class="check"><input type="checkbox" name="tracksKpi" id="goal-tracks-kpi" ${tracksKpi ? 'checked' : ''}> Track a KPI with touchpoints</label>
     <fieldset class="kpi-fields" id="goal-kpi-fields" ${tracksKpi ? '' : 'hidden disabled'}>
       <label>KPI<input name="kpi" maxlength="200" required placeholder="e.g. Monthly recurring revenue" value="${esc(g.kpi)}"></label>
       <div class="row">
         <label>Unit<select name="unit">${options(UNITS.map((u) => [u, u]), g.unit || 'count')}</select></label>
         <label>Direction<select name="direction">${options([['higher', 'Higher is better'], ['lower', 'Lower is better']], g.direction || 'higher')}</select></label>
       </div>
       <div class="row">
         <label>Baseline<input name="baseline" type="number" step="any" placeholder="Not measured yet" value="${esc(g.baseline)}"></label>
         <label>Target<input name="target" type="number" step="any" placeholder="Not set yet" value="${esc(g.target)}"></label>
       </div>
       <p class="hint">Leave baseline blank to use the first touchpoint. Without a target there's no pace.</p>
     </fieldset>
     <p class="hint" id="goal-no-kpi" ${tracksKpi ? 'hidden' : ''}>Progress comes from checking off milestones.</p>
     <div class="row">
       <label>Start<input name="startDate" type="date" required value="${esc(g.startDate)}"></label>
       <label>Due<input name="dueDate" type="date" required value="${esc(g.dueDate)}"></label>
     </div>
     ${buttons(goal ? 'Save' : 'Add goal', { del: goal && 'Delete goal' })}`,
    async (data, action) => {
      if (action === 'delete') {
        if (!confirm(`Delete goal "${goal.name}" with its milestones and touchpoints?`)) return true;
        await api('DELETE', `/goals/${goal.id}`);
        removeRow('goals', goal.id);
        state.milestones = state.milestones.filter((m) => m.goalId !== goal.id);
        state.touchpoints = state.touchpoints.filter((t) => t.goalId !== goal.id);
        return;
      }
      if (data.dueDate < data.startDate) throw new Error('Due date must be on or after the start date.');
      const num = (v) => (v === undefined || v === '' ? null : Number(v));
      const { tracksKpi: _, ...fields } = data;
      const body = data.tracksKpi
        ? { ...fields, laneId: Number(data.laneId), baseline: num(data.baseline), target: num(data.target) }
        : { ...fields, laneId: Number(data.laneId), kpi: '', unit: null, direction: null, baseline: null, target: null };
      upsert('goals', await api(goal ? 'PATCH' : 'POST', goal ? `/goals/${goal.id}` : '/goals', body));
    },
  );
  wireKpiToggle();
}

function wireKpiToggle() {
  const box = $('#goal-tracks-kpi');
  const fields = $('#goal-kpi-fields');
  box?.addEventListener('change', () => {
    fields.hidden = fields.disabled = !box.checked;
    $('#goal-no-kpi').hidden = box.checked;
  });
}

function milestoneModal(goalId) {
  if (!state.goals.length) return goalModal();
  openModal(
    `<h2>New milestone</h2>
     <label>Goal<select name="goalId">${goalOptions(goalId)}</select></label>
     <label>Name<input name="name" required maxlength="200"></label>
     <label>Date<input name="date" type="date" required value="${today()}"></label>
     ${buttons('Add milestone')}`,
    async (data) => {
      upsert('milestones', await api('POST', '/milestones', { ...data, goalId: Number(data.goalId) }));
    },
  );
}

const UNIT_AFFIX = { $: ['$', ''], '%': ['', '%'], count: ['', 'count'], days: ['', 'days'], weeks: ['', 'weeks'], score: ['', 'score'] };

function touchpointModal(goalId) {
  const kpiGoals = state.goals.filter(hasKpi);
  if (!kpiGoals.length) return toast('No goals track a KPI yet. Add one with "+ Goal".');
  const t = today();
  const selected =
    goalId ||
    kpiGoals.filter((g) => g.startDate <= t && t < g.dueDate).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1))[0]?.id ||
    kpiGoals[0].id;
  const touchpointsFor = (gid) =>
    state.touchpoints.filter((tp) => tp.goalId === Number(gid)).sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : b.id - a.id));

  // One line about the latest touchpoint, so a repeat entry is easy to spot.
  const lastHTML = (gid) => {
    const goal = byId('goals', gid);
    const last = touchpointsFor(gid)[0];
    if (!last) {
      return goal.baseline === null
        ? `No touchpoints yet, and no baseline. This first one will serve as the baseline.`
        : `No touchpoints yet. Baseline is <b>${esc(fmtVal(goal.baseline, goal.unit))}</b>.`;
    }
    const ago = daysBetween(last.date, today());
    const when = ago === 0 ? 'today' : ago === 1 ? 'yesterday' : `${ago} days ago`;
    return `Last logged <b>${esc(fmtVal(last.value, goal.unit))}</b> on ${fmtDate(last.date, { withYear: true })} (${when})${last.note ? ` · “${esc(last.note)}”` : ''}`;
  };
  const historyHTML = (gid) => {
    const goal = byId('goals', gid);
    const tps = touchpointsFor(gid);
    if (!tps.length) return '';
    return `<details class="all-tps"><summary>All touchpoints · ${tps.length}</summary><ul class="history">${tps
      .map(
        (tp) => `<li><time>${fmtDate(tp.date, { withYear: true })}</time><span class="v">${esc(fmtVal(tp.value, goal.unit))}</span>
          <span class="n">${esc(tp.note)}</span><button type="button" data-action="del-tp" data-id="${tp.id}" title="Delete touchpoint" aria-label="Delete touchpoint">×</button></li>`,
      )
      .join('')}</ul></details>`;
  };
  const unitHint = (gid) => {
    const g = byId('goals', gid);
    return `${esc(g.kpi)} · ${g.direction === 'lower' ? 'lower' : 'higher'} is better · target ${g.target === null ? 'not set' : esc(fmtVal(g.target, g.unit))}`;
  };
  const affix = (gid) => UNIT_AFFIX[byId('goals', gid).unit] || ['', ''];
  const [pre, post] = affix(selected);
  openModal(
    `<h2>Log touchpoint</h2>
     <label>Goal<select name="goalId" id="tp-goal">${goalOptions(selected, { kpiOnly: true })}</select></label>
     <p class="hint" id="tp-hint">${unitHint(selected)}</p>
     <p class="last-tp" id="tp-last">${lastHTML(selected)}</p>
     <div class="row">
       <label>Date<input name="date" id="tp-date" type="date" required value="${today()}"></label>
       <label>Value<span class="affixed"><span class="pre" id="tp-pre">${esc(pre)}</span><input name="value" id="tp-value" type="number" step="any" required><span class="post" id="tp-post">${esc(post)}</span></span></label>
     </div>
     <p class="dupe" id="tp-dupe" hidden></p>
     <label>Note<textarea name="note" rows="2" maxlength="5000"></textarea></label>
     <div id="tp-history">${historyHTML(selected)}</div>
     ${buttons('Log')}`,
    async (data) => {
      upsert('touchpoints', await api('POST', '/touchpoints', { ...data, goalId: Number(data.goalId), value: Number(data.value) }));
      toast('Touchpoint logged');
    },
  );
  const sel = $('#tp-goal');
  const checkDupe = () => {
    const same = touchpointsFor(sel.value).find((tp) => tp.date === $('#tp-date').value);
    const el = $('#tp-dupe');
    el.hidden = !same;
    if (same) el.textContent = `There's already a touchpoint on this date (${fmtVal(same.value, byId('goals', sel.value).unit)}). Logging again adds a second one.`;
  };
  const refresh = () => {
    const [p, q] = affix(sel.value);
    $('#tp-pre').textContent = p;
    $('#tp-post').textContent = q;
    $('#tp-hint').innerHTML = unitHint(sel.value);
    $('#tp-last').innerHTML = lastHTML(sel.value);
    $('#tp-history').innerHTML = historyHTML(sel.value);
    checkDupe();
  };
  sel.addEventListener('change', refresh);
  $('#tp-date').addEventListener('input', checkDupe);
  modalForm.refreshHistory = refresh;
  checkDupe();
}

// ---- actions --------------------------------------------------------------

async function toggleMilestone(id, done) {
  const m = byId('milestones', id);
  const prev = { ...m };
  Object.assign(m, { done, completedOn: done ? today() : null }); // optimistic
  render();
  try {
    upsert('milestones', await api('PATCH', `/milestones/${id}`, { done, today: today() }));
  } catch (err) {
    Object.assign(m, prev);
    toast(err.message);
  }
  render();
}

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.matches('input[data-action="toggle-ms"]')) toggleMilestone(Number(el.dataset.id), el.checked);
});

document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (d.matches?.('details.past')) {
    const id = Number(d.dataset.lane);
    if (d.open) openPast.add(id);
    else openPast.delete(id);
  }
}, true);

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.matches('input')) return;
  const { action, id, goal, lane } = el.dataset;
  switch (action) {
    case 'jump':
    case 'jump-goal': {
      // The roundup jumps to the first card with that flag; "+ N more active goals"
      // highlights all N and scrolls to the first.
      const cards =
        action === 'jump-goal'
          ? el.dataset.ids.split(' ').map((gid) => document.querySelector(`#board .card[data-goal="${gid}"]`)).filter(Boolean)
          : [[...document.querySelectorAll('.card')].find((c) => c.dataset.flags.split(' ').includes(el.dataset.kind))].filter(Boolean);
      if (!cards.length) return;
      cards[0].closest('details')?.setAttribute('open', '');
      cards[0].scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center', inline: 'center' });
      for (const card of cards) {
        card.classList.remove('flash');
        void card.offsetWidth;
        card.classList.add('flash');
      }
      return;
    }
    case 'settings':
      return settingsModal();
    case 'del-company': {
      const c = byId('companies', id);
      const n = state.lanes.filter((l) => l.companyId === c.id).length;
      if (!confirm(`Delete "${c.name}"?${n ? ` ${n} lane${n === 1 ? '' : 's'} will have no company.` : ''}`)) return;
      try {
        await api('DELETE', `/companies/${id}`);
        removeRow('companies', c.id);
        state.lanes.forEach((l) => l.companyId === c.id && (l.companyId = null));
        modalForm.refreshHistory?.();
        render();
      } catch (err) {
        showError(err.message);
      }
      return;
    }
    case 'add-lane':
      return laneModal();
    case 'edit-lane':
      return laneModal(byId('lanes', id));
    case 'add-goal':
      return goalModal(null, lane && Number(lane));
    case 'edit-goal':
      return goalModal(byId('goals', id));
    case 'add-ms':
      return milestoneModal(goal && Number(goal));
    case 'log-tp':
      return touchpointModal(goal && Number(goal));
    case 'del-ms': {
      const m = byId('milestones', id);
      if (!confirm(`Delete milestone "${m.name}"?`)) return;
      try {
        await api('DELETE', `/milestones/${id}`);
        removeRow('milestones', Number(id));
        render();
      } catch (err) {
        toast(err.message);
      }
      return;
    }
    case 'del-tp': {
      if (!confirm('Delete this touchpoint?')) return;
      try {
        await api('DELETE', `/touchpoints/${id}`);
        removeRow('touchpoints', Number(id));
        modalForm.refreshHistory?.();
        render();
      } catch (err) {
        showError(err.message);
      }
      return;
    }
    case 'toggle-theme': {
      const root = document.documentElement;
      const current = root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const next = current === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try {
        localStorage.setItem('plan-theme', next);
      } catch {}
      return;
    }
  }
});

let pressedOutside = false;
const outside = (e) => {
  const r = modal.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
};
modal.addEventListener('mousedown', (e) => (pressedOutside = e.target === modal && outside(e)));
modal.addEventListener('click', (e) => {
  if (pressedOutside && e.target === modal && outside(e)) modal.close();
  pressedOutside = false;
});

modal.addEventListener('close', () => {
  onSubmit = null;
  modalForm.refreshHistory = null;
});

// Keep "today" honest if the tab stays open past midnight.
let renderedFor = today();
setInterval(() => {
  if (today() !== renderedFor) {
    renderedFor = today();
    render();
  }
}, 60000);

async function load() {
  try {
    state = await api('GET', '/state');
    render();
  } catch (err) {
    board.innerHTML = `<p class="empty">Couldn't load the plan: ${esc(err.message)}</p>`;
  }
}

load();
