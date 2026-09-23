import {
  deriveGoal,
  laneBands,
  localToday,
  nextOpenMilestone,
  sortMilestones,
  daysBetween,
  PACE_LABEL,
} from './derive.js';

const UNITS = ['$', '%', 'count', 'days', 'weeks', 'score'];
const LANE_COLORS = ['#4f6d8f', '#8a6d3b', '#5b7f5b', '#8f4f6d', '#6d5b8f', '#3b7f7f', '#8f6d4f'];

let state = { lanes: [], goals: [], milestones: [], touchpoints: [] };
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
const lanesSorted = () => [...state.lanes].sort((a, b) => a.order - b.order || a.id - b.id);

// ---- rendering ------------------------------------------------------------

function laneColorStyle(lane) {
  return `--lane:${esc(lane.color)}`;
}

function stripHTML(lane, current) {
  if (!current) {
    return `<div class="strip" style="${laneColorStyle(lane)}"><span class="none">No active goal</span></div>`;
  }
  const next = nextOpenMilestone(state.milestones.filter((m) => m.goalId === current.id));
  const label = current.startDate > today() ? '<small>Next · </small>' : '';
  const nextHTML = next
    ? `<div class="next"><label><input type="checkbox" data-action="toggle-ms" data-id="${next.id}">
         <span class="name">${esc(next.name)}</span></label>
         <time datetime="${next.date}" title="${fmtDate(next.date, { withYear: true })}">${fmtDate(next.date)} · ${relDays(next.date)}</time></div>`
    : `<div class="next none">No open milestones</div>`;
  return `<div class="strip" style="${laneColorStyle(lane)}">
      <div class="goal-name" title="${esc(current.name)}">${label}${esc(current.name)}</div>
      ${nextHTML}
    </div>`;
}

function cardHTML(goal, lane) {
  const t = today();
  const d = deriveGoal(goal, state.touchpoints.filter((tp) => tp.goalId === goal.id), t);
  const ms = sortMilestones(state.milestones.filter((m) => m.goalId === goal.id));
  const pace = d.pace
    ? `<span class="pace ${d.pace}" title="Expected today ${esc(fmtVal(d.expectedToday, goal.unit))}">${PACE_LABEL[d.pace]}</span>`
    : `<span class="pace none">No data</span>`;
  const statusClass = d.status.replace(/\s+/g, '-');
  const meta = [
    `<span class="status ${statusClass}">${d.status}</span>`,
    d.gap !== null ? `<span title="Current minus expected today (${esc(fmtVal(d.expectedToday, goal.unit))})">${fmtSigned(d.gap, goal.unit)} vs pace</span>` : '',
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
  return `<article class="card ${d.phase}" style="${laneColorStyle(lane)}" data-goal="${goal.id}">
      <div class="card-head">
        <h3><button data-action="edit-goal" data-id="${goal.id}" title="${esc(goal.description || 'Edit goal')}">${esc(goal.name)}</button></h3>
        ${pace}
      </div>
      ${goal.kpi ? `<div class="kpi">${esc(goal.kpi)} · ${goal.direction === 'lower' ? 'lower' : 'higher'} is better</div>` : ''}
      <dl class="nums">
        <div><dt>Current</dt><dd>${fmtVal(d.current, goal.unit)}</dd></div>
        <div><dt>Target</dt><dd>${fmtVal(goal.target, goal.unit)}</dd></div>
        <div><dt>Due</dt><dd title="${fmtDate(goal.dueDate, { withYear: true })}">${fmtDate(goal.dueDate)}</dd></div>
      </dl>
      <div class="bar" title="Progress from ${esc(fmtVal(goal.baseline, goal.unit))}; tick marks where today's pace expects you">
        <span class="fill" style="width:${(d.progress * 100).toFixed(1)}%"></span>
        ${d.phase !== 'ahead' ? `<span class="tick" style="left:${(d.expectedProgress * 100).toFixed(1)}%"></span>` : ''}
      </div>
      <div class="meta">${meta}</div>
      ${milestones}
      <div class="card-foot">
        <button data-action="log-tp" data-goal="${goal.id}">Log touchpoint</button>
        <button data-action="add-ms" data-goal="${goal.id}">+ Milestone</button>
      </div>
    </article>`;
}

function render() {
  const t = today();
  $('#today-label').textContent = new Date(`${t}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const lanes = lanesSorted();
  if (!lanes.length) {
    board.innerHTML = `<p class="empty">No lanes yet.<br><br><button data-action="add-lane">+ Add a lane</button></p>`;
    indexNav.innerHTML = '';
    return;
  }
  const columns = [];
  const index = [];
  for (const lane of lanes) {
    const bands = laneBands(state.goals.filter((g) => g.laneId === lane.id), t);
    const strip = stripHTML(lane, bands.current);
    const title = `<div class="lane-title"><span class="dot" style="${laneColorStyle(lane)}"></span>
        <h2><button data-action="edit-lane" data-id="${lane.id}" title="Edit lane">${esc(lane.name)}</button></h2>
        <button class="add" data-action="add-goal" data-lane="${lane.id}" title="Add goal to ${esc(lane.name)}">+ Goal</button></div>`;
    index.push(`<a href="#lane-${lane.id}"><div class="lane-title"><span class="dot" style="${laneColorStyle(lane)}"></span><h2>${esc(lane.name)}</h2></div>${strip}</a>`);
    const empty = !bands.active.length && !bands.ahead.length && !bands.past.length;
    columns.push(`<section class="lane" id="lane-${lane.id}" style="${laneColorStyle(lane)}">
        <div class="lane-head">${title}${strip}</div>
        ${bands.active.map((g) => cardHTML(g, lane)).join('')}
        <div class="today-line">Today</div>
        ${bands.ahead.map((g) => cardHTML(g, lane)).join('')}
        ${empty ? `<p class="empty-lane">No goals yet.</p>` : ''}
        ${
          bands.past.length
            ? `<details class="past" data-lane="${lane.id}" ${openPast.has(lane.id) ? 'open' : ''}>
                <summary>Past · ${bands.past.length}</summary>
                <div class="stack">${bands.past.map((g) => cardHTML(g, lane)).join('')}</div>
              </details>`
            : ''
        }
      </section>`);
  }
  board.innerHTML = columns.join('');
  indexNav.innerHTML = index.join('');
}

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

function goalOptions(selected) {
  return lanesSorted()
    .map((lane) => {
      const goals = state.goals.filter((g) => g.laneId === lane.id).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
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
      const body = { name: data.name, color: data.color };
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

function goalModal(goal, laneId) {
  if (!state.lanes.length) return laneModal();
  const g = goal || {
    laneId: laneId || lanesSorted()[0].id,
    unit: 'count',
    direction: 'higher',
    startDate: today(),
  };
  openModal(
    `<h2>${goal ? 'Edit goal' : 'New goal'}</h2>
     <label>Lane<select name="laneId">${options(lanesSorted().map((l) => [l.id, l.name]), g.laneId)}</select></label>
     <label>Name<input name="name" required maxlength="200" value="${esc(g.name)}"></label>
     <label>Description<textarea name="description" rows="2" maxlength="5000">${esc(g.description)}</textarea></label>
     <label>KPI<input name="kpi" maxlength="200" placeholder="e.g. Monthly recurring revenue" value="${esc(g.kpi)}"></label>
     <div class="row">
       <label>Unit<select name="unit">${options(UNITS.map((u) => [u, u]), g.unit)}</select></label>
       <label>Direction<select name="direction">${options([['higher', 'Higher is better'], ['lower', 'Lower is better']], g.direction)}</select></label>
     </div>
     <div class="row">
       <label>Baseline<input name="baseline" type="number" step="any" required value="${esc(g.baseline)}"></label>
       <label>Target<input name="target" type="number" step="any" required value="${esc(g.target)}"></label>
     </div>
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
      const body = {
        ...data,
        laneId: Number(data.laneId),
        baseline: Number(data.baseline),
        target: Number(data.target),
      };
      upsert('goals', await api(goal ? 'PATCH' : 'POST', goal ? `/goals/${goal.id}` : '/goals', body));
    },
  );
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

function touchpointModal(goalId) {
  if (!state.goals.length) return goalModal();
  const selected = goalId || state.goals[0].id;
  const historyHTML = (gid) => {
    const goal = byId('goals', gid);
    const tps = state.touchpoints
      .filter((t) => t.goalId === Number(gid))
      .sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : b.id - a.id));
    if (!tps.length) return `<p class="hint">No touchpoints yet. Baseline is ${esc(fmtVal(goal.baseline, goal.unit))}.</p>`;
    return `<ul class="history">${tps
      .map(
        (t) => `<li><time>${fmtDate(t.date, { withYear: true })}</time><span class="v">${esc(fmtVal(t.value, goal.unit))}</span>
          <span class="n">${esc(t.note)}</span><button type="button" data-action="del-tp" data-id="${t.id}" title="Delete touchpoint" aria-label="Delete touchpoint">×</button></li>`,
      )
      .join('')}</ul>`;
  };
  const unitHint = (gid) => {
    const g = byId('goals', gid);
    return `${g.kpi ? esc(g.kpi) + ' · ' : ''}unit ${esc(g.unit)} · target ${esc(fmtVal(g.target, g.unit))}`;
  };
  openModal(
    `<h2>Log touchpoint</h2>
     <label>Goal<select name="goalId" id="tp-goal">${goalOptions(selected)}</select></label>
     <p class="hint" id="tp-hint">${unitHint(selected)}</p>
     <div class="row">
       <label>Date<input name="date" type="date" required value="${today()}"></label>
       <label>Value<input name="value" type="number" step="any" required></label>
     </div>
     <label>Note<textarea name="note" rows="2" maxlength="5000"></textarea></label>
     <div id="tp-history">${historyHTML(selected)}</div>
     ${buttons('Log')}`,
    async (data) => {
      upsert('touchpoints', await api('POST', '/touchpoints', { ...data, goalId: Number(data.goalId), value: Number(data.value) }));
      toast('Touchpoint logged');
    },
  );
  const sel = $('#tp-goal');
  sel.addEventListener('change', () => {
    $('#tp-hint').innerHTML = unitHint(sel.value);
    $('#tp-history').innerHTML = historyHTML(sel.value);
  });
  modalForm.refreshHistory = () => ($('#tp-history').innerHTML = historyHTML(sel.value));
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
