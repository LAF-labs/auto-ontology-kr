# @ours/insights — reports and alerts

Reports whose numbers come from saved-analysis runs, and alert rules the host evaluates without a model.

| Row (`cordis.patch.yml`) | What |
| --- | --- |
| `insights` → `@ours/insights` | Host service `ctx.insights`: storage domain `ours_insights` (`reports`, `rules`, `firings`), the alert timer, the "원인 분석" Session. The client half (Reports and Alerts panels) attaches here. |
| `insights-http` → `@ours/insights/http` | `/api/insights/*` routes (owner cookie). |
| preset row `@ours/insights/tools` | `report_save`, `report_list`, `report_read`, `alert_propose_rule`, `alert_list`. Mounted only by the `analyst` preset. |

Logic lives in `src/` without harness imports; `node --test tests/*.test.js`.

## Reports

The agent writes Markdown with `{{fig:<id>}}` placeholders and declares figures; the host runs the analyses itself (`aoConnector.runAnalysis`, cache up to `figureMaxAgeS`) and stores each value with its source. Typed numbers in title or body are refused (`hand_written_numbers`); allowed are calendar forms (`2026-10`, `10월`, `3분기`), integers up to 10, identifiers (`v2`, `Q3`) and the figures' parameter values.

```json
{"title": "2026년 10월 승인 리뷰 증빙 월간 보고",
 "body": "10월 승인 건수는 {{fig:oct}}로 9월 {{fig:sep}} 대비 {{fig:mom}} 변했다.\n\n{{fig:trend}}",
 "figures": [
   {"id": "sep", "kind": "value", "analysis_id": "…", "params": {"start_date": "2026-09-01", "end_date": "2026-10-01"}, "column": "approved_review_proof_count"},
   {"id": "oct", "kind": "value", "analysis_id": "…", "params": {"start_date": "2026-10-01", "end_date": "2026-11-01"}, "column": "approved_review_proof_count"},
   {"id": "mom", "kind": "change", "from": "sep", "to": "oct"},
   {"id": "trend", "kind": "table", "analysis_id": "…", "max_rows": 12}]}
```

- `value`: `column` plus `row` (index) or `where` ({column: value}), `reduce` (`first`, `sum`, `min`, `max`, `count`), `format` (`number`, `percent` for ratios, `raw`), `decimals`.
- `table`: `columns` (subset), `max_rows` ≤ 50. `change`: `from`, `to` value figures, `format` `change` (percent) or `difference`.
- Stored figure: `analysis {id, name, version, status, verified}`, resolved `params`, `executed_at`, `cache_hit`, `source`, the value (`value`, `number`, `text`) or `table`. A change figure stores both ends and `verified` when both are.
- Any failed figure refuses the whole report (`figure_failed`). Unverified versions are allowed with an explicit `version` and are marked.
- `trigger`: `{kind: "schedule", schedule_id, schedule_title, occurrence_at}` when the saving Session received a delivery of a Host Schedule task (matched by the task's receipts, not by the model's word), else `{kind: "session"}`.
- Reports are append-only. `maxReports` (5000) keeps the newest.

## Alert rules

```json
{"name": "승인 리뷰 증빙 월 10,000건 초과", "analysis_id": "…", "version": null,
 "params": {"start_date": "month_start(0)", "end_date": "month_start(1)"},
 "value": {"column": "approved_review_proof_count"},
 "condition": {"kind": "threshold", "op": ">", "value": 10000}, "interval_s": 3600}
```

- `condition`: `{kind: "threshold", op: > >= < <=, value}` or `{kind: "change", op: >= <= abs>=, percent, previous_params}`; `previous_params` are merged over `params` for the previous period.
- Verified only: creating or turning on a rule reads the analysis; a pinned version must be `verified`, an unpinned rule needs `latest_verified_version`. Columns and parameter names are checked. Each evaluation also refuses a result whose `status` is not `verified`.
- Evaluation: every `tickS` the host collects due active rules and sends one `run-batch` per 50 items (`max_age_s` = the rule's interval, `deadline_s` = `batchDeadlineS`). No model is called. A rule fires when its condition becomes true and again only after it was false. Errors are stored on the rule (`state.last_error`) and never fire.
- Limits: `maxRules` (20, pending included), `minIntervalS` (300), `maxIntervalS` (7 days), `maxFirings` (1000).
- Status: a person's rule starts `active`; an agent's (`alert_propose_rule`) starts `pending` and is evaluated only after a person turns it on in the Alerts panel.
- Firing: rule name, condition text, value and previous value with texts, change percent, analysis with version and verification, resolved params, `executed_at`, `read_at`, `investigation_session_id`.
- "원인 분석" (`POST /api/insights/investigate`) creates an `analyst` Session outside every Workspace, names it, and sends `investigationPrompt` with the firing as JSON. The second press reopens the same Session without a model call.

## Host events for later delivery

`ours-insights/report-saved` (report) and `ours-insights/alert-fired` (firing) are emitted with `ctx.parallel` after the record is stored; listener failures are logged. Mail or messenger delivery is a listener on these events; none exists yet.
