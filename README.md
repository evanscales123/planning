# Plan

A single-screen tracker for long-term plans across several business lines.
One column per lane, time running downward, goal cards with pace and
milestone checklists, and a sticky strip above each column showing the
current goal and its next open milestone.

Stack: Node 22 + Express + Postgres, vanilla JS frontend (no build step).

## Run locally

```sh
npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/plan
export APP_PASSWORD=choose-something
npm start          # http://localhost:3000
npm test           # derived-metric and seed-loader tests
```

The schema is created on boot. If the database is empty and `plan.json`
exists (or whatever `SEED_FILE` points to), it is loaded automatically.

## Deploy on Railway

1. New project → **Deploy from GitHub repo** → this repo.
2. **+ New → Database → PostgreSQL** in the same project.
3. On the app service, set variables:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `APP_PASSWORD` = your password
   - `SESSION_SECRET` (optional) = any long random string
4. Generate a domain under **Settings → Networking**.

`railway.json` sets the start command and a `/healthz` health check.
Railway supplies `PORT`. If you connect over Postgres's public proxy URL
rather than the private network, also set `DATABASE_SSL=1`.

## Seeding from plan.json

`plan.json` in the repo root loads on first boot into an empty database.
To keep it out of git instead, delete it and load it from your machine
against the Railway database:

```sh
railway run npm run seed -- plan.json            # only if the DB is empty
railway run npm run seed -- plan.json --reset    # wipe and reload
```

The whole file is validated before anything is written; errors name the
lane, goal and field at fault.

### plan.json format

See `plan.example.json`. Lanes may nest their goals, and goals may nest
milestones and touchpoints:

```json
{
  "lanes": [
    {
      "name": "Consulting",
      "color": "#4f6d8f",
      "goals": [
        {
          "name": "Grow retainer revenue",
          "description": "…",
          "kpi": "Monthly retainer revenue",
          "unit": "$",
          "direction": "higher",
          "baseline": 12000,
          "target": 30000,
          "startDate": "2026-04-01",
          "dueDate": "2026-12-31",
          "milestones": [{ "name": "First client converted", "date": "2026-08-31", "done": true }],
          "touchpoints": [{ "date": "2026-09-01", "value": 19000, "note": "…" }]
        }
      ]
    }
  ]
}
```

Or flat, referencing by name: top-level `goals` with `"lane": "<lane name>"`,
and `milestones` / `touchpoints` with `"goal": "<goal name>"` (add `"lane"`
if two goals share a name). The shapes can be mixed.

- `kpi` is optional. Leave it out for a milestone-only goal (no unit,
  baseline or target needed).
- `unit`: one of `$`, `%`, `count`, `days`, `weeks`, `score` (default `count`)
- `direction`: `higher` or `lower` (default `higher`)
- `baseline` / `target` may be `null` (not measured / not set yet)
- a goal's `notes` are appended to its description; `"draft": true` adds
  "Draft: target not confirmed yet." there. Other keys (`key`, a lane's
  `goal`, milestone `notes`, `meta`) are ignored.
- dates: `YYYY-MM-DD`; snake_case keys (`start_date`, `due_date`,
  `completed_on`) and `start` / `due` are accepted too
- lane `color` and `order` are optional; lane order defaults to file order

## How values are derived

Nothing below is stored; it's computed in `public/derive.js` using the
viewer's local date.

- **current**: value of the goal's latest touchpoint
- **expectedToday**: `baseline + (target − baseline) × clamp((today − start) / (due − start), 0, 1)`
- **gapToPace**: `current − expectedToday`
- **pace**: *On pace* if `|gap| ≤ 10% × |target − baseline|`, otherwise
  *Ahead* or *Behind* according to direction
- **status**, first match wins: *No touchpoint* → *Reached* (current meets
  target) → *Overdue* (past due, not reached) → *Stale* (latest touchpoint
  more than 120 days old) → *In progress*
- An unset **baseline** is taken from the goal's first touchpoint. With no
  **target** yet there's no pace, and the goal can't be *Reached*.
- **Goals without a KPI** track milestones instead: progress is milestones
  checked, and status is *Done* (all checked), *Overdue* or *In progress*.
  They take no touchpoints.

## Layout rules

- **Today** sits at the top of every lane: a sticky rule, drawn continuously
  across the columns, over a panel with the lane's current goal (the
  soonest-due active one, or the next upcoming one if none is active) and
  its next unchecked milestone. If that goal has no open milestones, the
  earliest one from the lane's other active goals shows instead. Checking
  it, in the panel or on the card, updates both immediately.
- Below Today, time runs downward: active goals (`start ≤ today < due`)
  under **Now**, then upcoming goals by due date with a marker at each new
  year. Goals whose due date has passed collapse into **Past** at the
  bottom. All sorted by due date.
- Under 760px wide the columns stack and the Today panels become an index
  at the top of the page.
