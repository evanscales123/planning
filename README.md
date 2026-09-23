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

Either commit `plan.json` to the repo root (it loads on first boot into an
empty database), or load it from your machine against the Railway database:

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

- `unit`: one of `$`, `%`, `count`, `days`, `weeks`, `score` (default `count`)
- `direction`: `higher` or `lower` (default `higher`)
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

## Layout rules

- Goals in a column are sorted by due date. Active goals
  (`start ≤ today < due`) sit above the **Today** line, upcoming goals
  below it, and goals whose due date has passed collapse into a **Past**
  section at the bottom of the column.
- The header strip shows the soonest-due active goal (or the next upcoming
  one if none is active) and its earliest unchecked milestone. Checking it,
  in the strip or on the card, updates both immediately.
- Under 760px wide the columns stack and the strips become an index at the
  top of the page.
