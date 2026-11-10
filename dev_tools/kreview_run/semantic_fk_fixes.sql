-- SPDX-License-Identifier: Apache-2.0
-- Manual semantic-FK corrections for renewal_kreview (store: kreview_store).
-- Verified against data on 2026-11-10 (match = source rows whose value exists in target).
-- A full recompile (start.sh --reset) rebuilds column__semantic_fk, so re-apply this file after one.
BEGIN;

CREATE TEMP TABLE fk_fix (src_t text, src_c text, tgt_t text, tgt_c text, op text) ON COMMIT DROP;
INSERT INTO fk_fix VALUES
  -- wrong: only 1271/18688 match history_id by coincidence; 18684/18688 match applications
  ('provided_contents', 'assigned_to_application_id', 'linked_application_histories', 'history_id', 'delete'),
  ('provided_contents', 'assigned_to_application_id', 'applications', 'application_id', 'add'),
  -- missing, 100% match each
  ('campaigns', 'client_id', 'companies', 'company_id', 'add'),                          -- 5392/5392
  ('linked_application_histories', 'linked_campaign_id', 'campaigns', 'campaign_id', 'add'),      -- 6911/6911
  ('linked_application_histories', 'linked_application_id', 'applications', 'application_id', 'add'), -- 4036/4036
  ('campaign_link_rules', 'main_campaign_id', 'campaigns', 'campaign_id', 'add'),        -- 606/606
  ('campaign_link_rule_targets', 'linked_campaign_id', 'campaigns', 'campaign_id', 'add'), -- 218/218
  ('cash_receipt_requests', 'guest_proof_id', 'guest_proofs', 'proof_id', 'add'),        -- 28/28
  ('cash_receipt_requests', 'recovery_point_id', 'points', 'point_id', 'add'),           -- 4/4
  ('recruitment_links', 'issued_by', 'users', 'user_id', 'add'),                         -- 4407/4407
  ('inquiries', 'answer_admin_id', 'users', 'user_id', 'add');                           -- 612/612

CREATE TEMP VIEW fk_resolved AS
SELECT f.op, sc.id AS column_id, h.attribute_id
FROM fk_fix f
JOIN catalog_table st ON st.name = f.src_t
JOIN catalog_column sc ON sc.table_id = st.id AND sc.name = f.src_c
JOIN catalog_table tt ON tt.name = f.tgt_t
JOIN catalog_column tc ON tc.table_id = tt.id AND tc.name = f.tgt_c
JOIN column__has_attribute h ON h.column_id = tc.id;

DELETE FROM column__semantic_fk k USING fk_resolved r
WHERE r.op = 'delete' AND k.column_id = r.column_id AND k.attribute_id = r.attribute_id;

INSERT INTO column__semantic_fk (column_id, attribute_id, use_in_join_paths)
SELECT column_id, attribute_id, true FROM fk_resolved WHERE op = 'add'
ON CONFLICT DO NOTHING;

SELECT op, count(*) FROM fk_resolved GROUP BY op;
COMMIT;
