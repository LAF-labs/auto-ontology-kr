# Dashboard spec, format 1

A dashboard is data, not code. A spec says which widget modules to place where, and which saved analysis each widget reads. It holds no SQL: every number comes from a saved analysis in Auto-ontology, run through the connector. The validator is `src/spec.js` (`validateSpec`); the store refuses an invalid spec when a draft is saved, and checks it again on publish.

## Example

```json
{
  "format": 1,
  "title": "Orders overview",
  "description": "Weekly review",
  "grid": { "columns": 12, "row_height": 90 },
  "refresh_s": 300,
  "widgets": [
    {
      "id": "orders-last-month",
      "type": "number-tile",
      "type_version": 1,
      "title": "Orders last month",
      "layout": { "x": 0, "y": 0, "w": 3, "h": 2 },
      "source": { "analysis_id": "3f2c…", "params": { "start_date": "month_start(-1)", "end_date": "month_start(0)" } },
      "options": { "suffix": "" }
    },
    {
      "id": "top-stores",
      "type": "bar-chart",
      "type_version": 1,
      "layout": { "x": 3, "y": 0, "w": 9, "h": 4 },
      "source": { "analysis_id": "9a1d…", "params": { "top_n": 10 } },
      "refresh_s": 900,
      "options": { "x": "store_name", "y": "order_count" }
    }
  ]
}
```

## Fields

| Field | Required | Meaning |
|---|---|---|
| `format` | yes | `1` |
| `title` | yes | 1–120 characters; the tab label |
| `description` | no | up to 2000 characters |
| `grid.columns` | no | 1–24, default 12 |
| `grid.row_height` | no | pixels per grid row, 40–400, default 90 |
| `refresh_s` | no | default refresh interval for every widget, 30–86400 s, default 300 |
| `max_age_s` | no | how old a cached result may be when the runtime refreshes, 0–86400 s; default and ceiling: the widget's refresh interval |
| `widgets` | yes | 1–50 widgets |

Widget:

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | unique in the spec, `^[a-z0-9][a-z0-9_-]{0,62}$`; also the run-batch item key |
| `type`, `type_version` | yes | a widget module version in the store (`/api/dashboard/widgets`) |
| `title` | no | card title; default the analysis name |
| `layout` | yes | `x`, `y` (grid cell, from 0), `w`, `h` (cells); `x + w ≤ grid.columns`; widgets may not overlap |
| `source.analysis_id` | yes | saved analysis id |
| `source.version` | no | pin a version; default the latest verified version |
| `source.params` | no | parameter values (scalars or arrays of scalars), including relative dates such as `month_start(-1)` |
| `source.row_limit` | no | 1–50000; the analysis version's own limit still applies |
| `refresh_s` | no | this widget's refresh interval, 30–86400 s |
| `options` | no | display settings for the widget type: JSON, at most 6 levels deep, strings up to 2000 characters. Keys named `sql`, `query` or `statement` are refused at any depth |

Unknown fields are refused at every level except inside `options` and `source.params`.

`analysisIds(spec)` returns the saved-analysis ids a spec reads; it is the basis for limiting a dashboard's data access to exactly those analyses. `widgetRefs(spec)` returns the `type@version` modules it needs.

## Widget modules

A widget type is an ES module stored by `type` and `version`; a stored version never changes (a different file under the same version is refused). Each version has an origin: `basic` for modules a host package seeds (`@ours/widgets-basic`), `generated` for everything else (the editing agent's `dashboard_save_widget_type`, `POST /api/dashboard/widgets`). The runtime reads the module from `GET /api/dashboard/widget-module?type=…&version=…` and calls:

```js
export default {
  mount(el, props) {
    // draw into el
    return { update(nextProps) {}, destroy() {} }
  },
}
```

`props` is the whole interface between the runtime and a widget:

| Prop | Meaning |
|---|---|
| `rows` | result rows, arrays in column order (decimals arrive as strings) |
| `columns` | `[{ name, type, role, unit, label, description }]` from the analysis version's column hints |
| `options` | the widget's `options` from the spec |
| `theme` | `{ text, textSecondary, textTertiary, border, background, surface, accent, positive, warning, negative, series[], font }`, CSS color values read from the harness theme tokens |
| `locale` | the browser language, for number and date formatting |

A widget does not fetch, read storage, or reach the page outside `el`; it measures its own `el` when it needs a size.

- `basic` modules are imported into the page and run with the harness owner's rights; only reviewed code is seeded this way.
- `generated` modules run in an `<iframe sandbox="allow-scripts">` (opaque origin: no cookie, storage or access to the page) whose document carries the policy `default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'` (no network). The page sends the module source and the props by `postMessage`; the frame imports the source as a blob and calls `mount` on its `#root`, which fills the card body. The same module works in both places.
- Saving a generated module through the editing tool also refuses code that names network, storage, cookie, parent-frame, `eval` or import APIs, so the agent learns the rule at save time; the frame is what enforces it.

## Basic widgets (`@ours/widgets-basic`, version 1)

| Type | Options |
|---|---|
| `number-tile` | `column` (default first measure), `row` (default 0), `label`, `decimals`, `prefix`, `suffix`, `compare_row` (shows the change from that row) |
| `line-chart` | `x` (default first non-measure column), `y` (name or names; default all measures), `sort_x` (default true), `y_zero` (default true) |
| `bar-chart` | `x` (category; default first non-measure), `y` (default first measure), `orientation` (`horizontal` default, `vertical`), `sort` (`desc` default, `asc`, `none`), `limit` (default 20) |
| `table` | `columns` (names, in order; default all), `max_rows` (default 200), `decimals` |

## Versions, drafts and publishing

- Publishing creates version n+1 (immutable) and moves the dashboard's published pointer to it. Every browser reads the published version.
- A draft belongs to one browser (an owner id kept in that browser's localStorage, sent as `x-ours-draft-owner`). Other browsers do not see it. This is visibility, not access control: every browser is the same harness owner.
- A draft remembers the version it started from. If another publish happened since, publishing answers `409 base_changed` with the newer version, and the runtime asks before publishing with `force: true`.
- Reverting moves the pointer to an earlier version and records it in the history; it creates no version. It takes `expected` (the version the caller saw) and answers `409 base_changed` when the pointer moved meanwhile.
- Publishing checks every analysis the draft reads against Auto-ontology: a widget with `source.version` needs that version verified; a widget without it needs the analysis to have a verified version. Otherwise publishing answers `409 unverified_analyses` with `details.analyses` (`analysis_id`, `version`, `reason`), with or without `force`. A failed lookup counts as unverified (`unchecked:<code>`).

## Edit sessions

- `POST /api/dashboard/edit {id}` copies the published version into this browser's draft (or keeps the draft it has), creates a Session running the `dashboard-editor` preset outside every Workspace, binds the Session to that draft, and sends its first message (configurable; one agent turn). The binding is stored in the `editors` table by Session id.
- The editing tools (`@ours/dashboard/editor-tools`: `dashboard_read_draft`, `dashboard_edit_draft`, `dashboard_save_analysis`, `dashboard_save_widget_type`) act only on the draft bound to the calling Session and answer `not_bound` anywhere else, or `draft_gone` after that draft is published or discarded. No tool publishes or verifies.
- A draft analysis the agent saves is pinned in widgets with `source.version`, so the draft previews it; a person verifies it with the edit panel's button (`POST /api/ao/verify`, reviewer token), after which the draft can be published.
- `GET /api/dashboard/editor?session=` returns the binding, the draft, its unverified analyses and the analyses that Session saved, only to the browser that owns the draft.
