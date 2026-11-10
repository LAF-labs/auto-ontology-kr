-- SPDX-License-Identifier: Apache-2.0
-- Deterministic PII masking for renewal_kreview (prod dump -> local copy).
-- Same input -> same pseudonym, so joins/consistency across tables survive.
USE renewal_kreview;
SET SESSION sql_mode = '';
SET FOREIGN_KEY_CHECKS = 0;

DELIMITER //
CREATE OR REPLACE FUNCTION h4(x TEXT) RETURNS CHAR(4) DETERMINISTIC
  RETURN LPAD(CONV(LEFT(MD5(x), 5), 16, 10) % 10000, 4, '0')//
CREATE OR REPLACE FUNCTION m_name(x TEXT) RETURNS VARCHAR(50) DETERMINISTIC
  RETURN IF(x IS NULL OR x = '', x, CONCAT('고객', h4(x)))//
CREATE OR REPLACE FUNCTION m_phone(x TEXT) RETURNS VARCHAR(20) DETERMINISTIC
  RETURN IF(x IS NULL OR x = '', x, CONCAT('010-', h4(CONCAT('a', x)), '-', h4(x)))//
CREATE OR REPLACE FUNCTION m_email(x TEXT) RETURNS VARCHAR(100) DETERMINISTIC
  RETURN IF(x IS NULL OR x = '', x, CONCAT('user_', LEFT(MD5(x), 8), '@example.com'))//
CREATE OR REPLACE FUNCTION m_acct(x TEXT) RETURNS VARCHAR(50) DETERMINISTIC
  RETURN IF(x IS NULL OR x = '', x, CONCAT('000-0000-', h4(x)))//
-- login ids / *_by audit columns: keep system actors, pseudonymise people
CREATE OR REPLACE FUNCTION m_id(x TEXT) RETURNS VARCHAR(100) DETERMINISTIC
  RETURN CASE
    WHEN x IS NULL OR x = '' THEN x
    WHEN x REGEXP BINARY '^[A-Z_]+$' OR x IN ('admin', 'system', 'kreview') THEN x
    WHEN x REGEXP '^[0-9]+$' THEN x            -- numeric admin/user ids
    ELSE CONCAT('u_', LEFT(MD5(x), 8)) END//
CREATE OR REPLACE FUNCTION m_text(x LONGTEXT) RETURNS LONGTEXT DETERMINISTIC
  RETURN IF(x IS NULL, x,
    REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(x,
      '01[016789][-. ]?[0-9]{3,4}[-. ]?[0-9]{4}', '010-0000-0000'),
      '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', 'user@example.com'),
      '[0-9]{3,6}-[0-9]{2,6}-[0-9]{4,8}(-[0-9]{1,6})?', '000-0000-0000'),
      '(?<![0-9])[0-9]{10,14}(?![0-9])', '0000000000'))//
DELIMITER ;

-- users
UPDATE users SET name = m_name(name), account_holder = m_name(account_holder),
  account_number = m_acct(account_number), phone = m_phone(phone), email = m_email(email),
  login_id = LEFT(m_id(login_id), 20), password = IF(password IS NULL, NULL, 'REDACTED'),
  kakao_id = IF(kakao_id IS NULL, NULL, CONCAT('k_', LEFT(MD5(kakao_id), 10))),
  provider_id = IF(provider_id IS NULL, NULL, CONCAT('p_', LEFT(MD5(provider_id), 10)));

UPDATE guest_users SET name = m_name(name),
  phone = CONCAT('010-', LPAD(guest_id DIV 10000, 4, '0'), '-', LPAD(guest_id MOD 10000, 4, '0')),
  account_number = m_acct(account_number), account_holder = m_name(account_holder);
UPDATE guest_payouts SET paid_account_number = m_acct(paid_account_number),
  paid_account_holder = m_name(paid_account_holder);
UPDATE points SET account_number = m_acct(account_number), account_holder = m_name(account_holder),
  description = m_text(description);
UPDATE cash_receipt_requests SET account_number = m_acct(account_number);

-- addresses / recipients
UPDATE applications SET recipient_name = m_name(recipient_name), shipping_phone = m_phone(shipping_phone),
  shipping_address = IF(shipping_address IS NULL OR shipping_address = '', shipping_address, '서울특별시 중구 세종대로 110 101동 101호');
UPDATE guest_proofs SET recipient_name = m_name(recipient_name), shipping_phone = m_phone(shipping_phone),
  shipping_address = IF(shipping_address IS NULL OR shipping_address = '', shipping_address, '서울특별시 중구 세종대로 110 101동 101호'),
  tracking_number = IF(tracking_number IS NULL, NULL, CONCAT('T', h4(tracking_number), h4(CONCAT(tracking_number, 'x')))),
  feedback = m_text(feedback);
UPDATE shipping_addresses SET recipient_name = m_name(recipient_name), recipient_phone = m_phone(recipient_phone),
  zipcode = IF(zipcode IS NULL, NULL, '04524'),
  address = IF(address IS NULL, NULL, '서울특별시 중구 세종대로 110'),
  address_detail = IF(address_detail IS NULL, NULL, '101동 101호');
UPDATE store_accounts SET recipient_name = m_name(recipient_name), shipping_phone = m_phone(shipping_phone),
  shipping_address = IF(shipping_address IS NULL OR shipping_address = '', shipping_address, '서울특별시 중구 세종대로 110 101동 101호'),
  store_user_id = IF(store_user_id IS NULL, NULL, CONCAT('store_', LEFT(MD5(store_user_id), 8))),
  store_user_name = m_name(store_user_name),
  nickname = IF(nickname IS NULL OR nickname = '', nickname, CONCAT('닉네임', h4(nickname)));
UPDATE purchase_proofs SET recipient_name = m_name(recipient_name), recipient_phone = m_phone(recipient_phone),
  feedback = m_text(feedback);
UPDATE review_proofs SET feedback = m_text(feedback);
UPDATE delivery_infos SET tracking_number = IF(tracking_number IS NULL, NULL, CONCAT('T', h4(tracking_number), h4(CONCAT(tracking_number, 'x'))));

-- business contacts / credentials
UPDATE companies SET manager_name = m_name(manager_name), manager_phone = m_phone(manager_phone),
  invoice_email = m_email(invoice_email), login_id = LEFT(m_id(login_id), 50),
  password = IF(password IS NULL, NULL, 'REDACTED'),
  business_number = IF(business_number IS NULL OR business_number = '', business_number,
    CONCAT(LPAD(CONV(LEFT(MD5(business_number), 3), 16, 10) % 1000, 3, '0'), '-',
           LPAD(CONV(SUBSTR(MD5(business_number), 4, 2), 16, 10) % 100, 2, '0'), '-',
           LPAD(CONV(SUBSTR(MD5(business_number), 6, 5), 16, 10) % 100000, 5, '0')));
UPDATE company_users SET user_name = m_name(user_name), user_email = m_email(user_email),
  user_phone = m_phone(user_phone), login_id = LEFT(m_id(login_id), 50), password = IF(password IS NULL, NULL, 'REDACTED');
UPDATE ad_quotations SET company_contact = m_phone(company_contact), company_email = m_email(company_email),
  description = m_text(description), special_requirements = m_text(special_requirements), response_message = m_text(response_message);
UPDATE ad_quotation_communications SET author_name = m_name(author_name), message = m_text(message);
UPDATE api_credentials SET credential_value = IF(credential_value IS NULL, NULL, 'REDACTED');
UPDATE partner_credentials SET api_key = 'REDACTED', secret = 'REDACTED', ip_allowlist = IF(ip_allowlist IS NULL, NULL, '0.0.0.0/32');
UPDATE refresh_tokens SET token = CONCAT('REDACTED_', refresh_token_id);
UPDATE recruitment_links SET token = LEFT(MD5(CONCAT('t', token)), 32);
UPDATE partner_point_transactions SET external_user_id = IF(external_user_id IS NULL, NULL, CONCAT('ext_', LEFT(MD5(external_user_id), 8))),
  response_snapshot = m_text(response_snapshot);
UPDATE persistent_cache SET cache_key = m_text(cache_key);

-- messages / free text
UPDATE alimtalk_histories SET
  message = m_text(IF(receiver_name IS NULL OR receiver_name = '', message, REPLACE(message, receiver_name, m_name(receiver_name)))),
  receiver_name = m_name(receiver_name), phone_number = m_phone(phone_number),
  api_response = m_text(api_response), error_message = m_text(error_message);
UPDATE alimtalk_histories SET message = REGEXP_REPLACE(message, '^[가-힣]{2,4}님', '고객님') WHERE message REGEXP '^[가-힣]{2,4}님';
UPDATE alimtalk_histories SET message = REGEXP_REPLACE(message, '인증번호는 \\[[0-9]+\\]', '인증번호는 [000000]');
UPDATE notifications SET message = m_text(message), title = m_text(title);
UPDATE inquiries SET content = m_text(content), answer_content = m_text(answer_content), title = m_text(title);
UPDATE campaign_communications SET content = m_text(content);
UPDATE linked_application_histories SET result_message = m_text(result_message);

-- uploaded files (receipt / review screenshots on a public image host)
UPDATE files SET file_url = CONCAT('https://example.com/files/', file_id, '.', SUBSTRING_INDEX(file_url, '.', -1)),
  original_file_name = CONCAT('file_', file_id, IF(LOCATE('.', original_file_name) > 0, CONCAT('.', SUBSTRING_INDEX(original_file_name, '.', -1)), ''));

-- *_by audit columns everywhere (login ids / kakao ids of people)
DELIMITER //
CREATE OR REPLACE PROCEDURE mask_audit_cols()
BEGIN
  DECLARE done INT DEFAULT 0;
  DECLARE t, c VARCHAR(64);
  DECLARE cur CURSOR FOR
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'renewal_kreview' AND data_type IN ('varchar', 'char')
      AND (column_name LIKE '%\\_by' OR column_name IN ('feedback_admin_id', 'sent_by'));
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;
  OPEN cur;
  l: LOOP
    FETCH cur INTO t, c;
    IF done THEN LEAVE l; END IF;
    SET @s = CONCAT('UPDATE `', t, '` SET `', c, '` = m_id(`', c, '`) WHERE `', c, '` IS NOT NULL');
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END LOOP;
  CLOSE cur;
END//
DELIMITER ;
CALL mask_audit_cols();

-- remove helper routines so they are not ingested as part of the schema
DROP PROCEDURE mask_audit_cols;
DROP FUNCTION h4; DROP FUNCTION m_name; DROP FUNCTION m_phone; DROP FUNCTION m_email;
DROP FUNCTION m_acct; DROP FUNCTION m_id; DROP FUNCTION m_text;
SET FOREIGN_KEY_CHECKS = 1;
