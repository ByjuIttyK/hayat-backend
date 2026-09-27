-- =====================================================================
--  access_rights_step1.sql  -  Telltron ERP user access rights, STEP 1
--  Rights are given PER MENU GROUP. module_code = the menu group's `key`
--  in Mainmenu.tsx (lpo, sinv, vgen ...).
--
--  Safe to run on any database (laptop, demo, production) and safe to
--  run again: creates tables if missing, removes the earlier per-screen
--  test rows, keeps every existing role and its rights, and copies rights
--  from old group codes to the current menu keys where the menu was
--  re-organised.
-- =====================================================================

-- 1. Menu groups that rights are given on
CREATE TABLE IF NOT EXISTS app_modules (
  module_code  VARCHAR(40)  NOT NULL PRIMARY KEY,
  module_name  VARCHAR(80)  NOT NULL,
  menu_group   VARCHAR(40)  NOT NULL,
  sub_group    VARCHAR(60)  DEFAULT NULL,
  is_entry     CHAR(1)      NOT NULL DEFAULT 'Y',  -- Y = has entry screens (Add/Edit/Delete/Post); N = reports only (View)
  sort_order   INT          NOT NULL DEFAULT 0,
  is_active    CHAR(1)      NOT NULL DEFAULT 'Y'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE role_permissions MODIFY module_code VARCHAR(40) NOT NULL;

-- 2. Per-user exceptions. NULL column = use the role's value.
CREATE TABLE IF NOT EXISTS user_permission_overrides (
  username     VARCHAR(100) NOT NULL,
  module_code  VARCHAR(40)  NOT NULL,
  can_view     CHAR(1) DEFAULT NULL,
  can_add      CHAR(1) DEFAULT NULL,
  can_edit     CHAR(1) DEFAULT NULL,
  can_delete   CHAR(1) DEFAULT NULL,
  can_post     CHAR(1) DEFAULT NULL,
  updated_by   VARCHAR(100) DEFAULT NULL,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (username, module_code),
  CONSTRAINT fk_upo_user FOREIGN KEY (username) REFERENCES users(username)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 3. Remove the per-screen test rows from the first version of this script
--    (route codes were UPPER CASE; menu keys are lower case).
DELETE FROM role_permissions WHERE BINARY module_code <> BINARY LOWER(module_code);
DELETE FROM app_modules      WHERE BINARY module_code <> BINARY LOWER(module_code);

-- 4. The menu groups (keys as in Mainmenu.tsx)
INSERT INTO app_modules (module_code, module_name, menu_group, is_entry, sort_order) VALUES
 ('supplier',   'Supplier Master',            'Masters',            'Y', 100),
 ('customer',   'Customer Master',            'Masters',            'Y', 110),
 ('glmain',     'Main Group G/L',             'Masters',            'Y', 120),
 ('glsubgroup', 'Sub Group G/L',              'Masters',            'Y', 130),
 ('glaccount',  'Accounts Master',            'Masters',            'Y', 140),
 ('banks',      'Bank Master',                'Masters',            'Y', 150),
 ('invmst',     'Inventory Masters',          'Masters',            'Y', 160),
 ('trantypes',  'Trans.Types Masters',        'Masters',            'Y', 170),
 ('nations',    'Nations Master',             'Masters',            'Y', 180),
 ('salesman',   'Salesman Master',            'Masters',            'Y', 190),
 ('jobstatus',  'Job-Status Master',          'Masters',            'Y', 200),
 ('inquiry',    'Inquiry Master',             'Masters',            'Y', 210),
 ('quotterms',  'Quot. Terms & Cond.',        'Masters',            'Y', 220),
 ('vat',        'V.A.T Master',               'Masters',            'Y', 230),
 ('lpo',        'Local Purchase Order',       'Purchase',           'Y', 300),
 ('fpo',        'Foreign Purchase Order',     'Purchase',           'Y', 310),
 ('lclpur',     'Purchase Invoice [Local]',   'Purchase',           'Y', 320),
 ('purfrgn',    'Purchase Invoice [Frgn]',    'Purchase',           'Y', 330),
 ('nstkp',      'Non-Stock Purchase',         'Purchase',           'Y', 340),
 ('ngp',        'Non-Goods Purchase',         'Purchase',           'Y', 350),
 ('pret',       'Purchase Returns',           'Purchase',           'Y', 360),
 ('purrpt',     'Purchase Reports',           'Purchase',           'N', 370),
 ('sinq',       'Sales Enquiry',              'Sales',              'Y', 400),
 ('trdsales',   'Trading Sales',              'Sales',              'Y', 410),
 ('mfgsales',   'Manufacturing Sales',        'Sales',              'Y', 420),
 ('pfinv',      'Proforma Invoice',           'Sales',              'Y', 430),
 ('sret',       'Sales Returns',              'Sales',              'Y', 440),
 ('crnt',       'Sales Credit Notes',         'Sales',              'Y', 450),
 ('drnt',       'Sales Debit Notes',          'Sales',              'Y', 460),
 ('salrpt',     'Sales Reports',              'Sales',              'N', 470),
 ('nldispatch', 'AI Entry Panel',             'Gen.Ledger',         'Y', 500),
 ('agentpanel', 'AI Agent Panel',             'Gen.Ledger',         'Y', 510),
 ('vgen',       'Voucher Generation',         'Gen.Ledger',         'Y', 520),
 ('pcash',      'Petty Cash Expenses',        'Gen.Ledger',         'Y', 530),
 ('brs',        'Bank Reconciliation',        'Gen.Ledger',         'Y', 540),
 ('pdcr',       'P.D.C Receivables',          'Gen.Ledger',         'Y', 550),
 ('pdci',       'P.D.C Issued',               'Gen.Ledger',         'Y', 560),
 ('curchq',     'Current Dated Cheques',      'Gen.Ledger',         'N', 570),
 ('trans',      'Transactions (Print/List)',  'Gen.Ledger',         'N', 580),
 ('glrpt',      'G/L Reports',                'Gen.Ledger',         'N', 590),
 ('srv',        'Store Receipt Vouchers',     'Inventory',          'Y', 600),
 ('siv',        'Store Issue Vouchers',       'Inventory',          'Y', 610),
 ('sadj',       'Stock Adjustment',           'Inventory',          'Y', 620),
 ('gtrn',       'Goods Transfer',             'Inventory',          'Y', 630),
 ('phystk',     'Physical Stock Entries',     'Inventory',          'Y', 640),
 ('projgraph',  'MFG Related Graphs',         'Manufacturing Jobs', 'N', 700),
 ('facat',      'Asset Category Master',      'Fixed Assets',       'Y', 800),
 ('faasset',    'Asset Master',               'Fixed Assets',       'Y', 810),
 ('fadeprun',   'Depreciation Run',           'Fixed Assets',       'Y', 820),
 ('fatransfer', 'Asset Transfer',             'Fixed Assets',       'Y', 830),
 ('fadisposal', 'Asset Disposal',             'Fixed Assets',       'Y', 840),
 ('farpt',      'Fixed Asset Reports',        'Fixed Assets',       'N', 850),
 ('jobcost',    'Job Cost Variance',          'Analytics',          'N', 900),
 ('inventory',  'Inventory Optimization',     'Analytics',          'N', 910),
 ('cashflow',   'Cash Flow Forecast',         'Analytics',          'N', 920),
 ('anomaly',    'Anomaly Detection',          'Analytics',          'N', 930),
 ('anlrpt',     'Analytics Dashboard',        'Analytics',          'N', 940),
 ('utilities',  'Utilities',                  'Utilities',          'Y', 990)
ON DUPLICATE KEY UPDATE module_name=VALUES(module_name), menu_group=VALUES(menu_group),
  is_entry=VALUES(is_entry), sort_order=VALUES(sort_order);

-- 5. Carry rights from old group codes to the current menu keys
--    (only where the role has no row for the new key yet; the most
--    generous right of the old codes is taken).
DROP TEMPORARY TABLE IF EXISTS ar_map;
CREATE TEMPORARY TABLE ar_map (old_code VARCHAR(40), new_code VARCHAR(40));
INSERT INTO ar_map VALUES
 ('glaccounts','glmain'),('glaccounts','glsubgroup'),('glaccounts','glaccount'),
 ('qt','trdsales'),('sinv','trdsales'),
 ('prjinv','mfgsales'),('jobs','mfgsales'),('jobs','projgraph'),
 ('fixedassets','facat'),('fixedassets','faasset'),('fixedassets','fadeprun'),
 ('fixedassets','fatransfer'),('fixedassets','fadisposal'),('fixedassets','farpt'),
 ('analytics','jobcost'),('analytics','inventory'),('analytics','cashflow'),
 ('analytics','anomaly'),('analytics','anlrpt');

INSERT IGNORE INTO role_permissions (role_name, module_code, can_view, can_add, can_edit, can_delete, can_post)
SELECT rp.role_name, m.new_code,
       MAX(rp.can_view), MAX(rp.can_add), MAX(rp.can_edit), MAX(rp.can_delete), MAX(rp.can_post)
  FROM role_permissions rp JOIN ar_map m ON m.old_code = rp.module_code
 GROUP BY rp.role_name, m.new_code;
DROP TEMPORARY TABLE ar_map;

-- 6. Standard roles. 'admin' always has every right in code (rows optional).
--    'user' = full rights on every group, so existing users see no change
--    when the checks go live; tighten per group later.
INSERT IGNORE INTO roles (role_name, remarks) VALUES
 ('admin',  'Full system access'),
 ('user',   'Standard user - full rights by default; tighten per screen as needed'),
 ('viewer', 'Read-only - can open screens and reports, cannot change data');

INSERT IGNORE INTO role_permissions (role_name, module_code, can_view, can_add, can_edit, can_delete, can_post)
SELECT 'user', module_code, 'Y', is_entry, is_entry, is_entry, is_entry FROM app_modules;
INSERT IGNORE INTO role_permissions (role_name, module_code, can_view, can_add, can_edit, can_delete, can_post)
SELECT 'viewer', module_code, 'Y', 'N', 'N', 'N', 'N' FROM app_modules;

-- 7. Check: menu groups, and per role how many groups have rights
SELECT menu_group, COUNT(*) AS groups_, SUM(is_entry='Y') AS entry_groups
  FROM app_modules GROUP BY menu_group ORDER BY MIN(sort_order);
SELECT rp.role_name,
       SUM(m.module_code IS NOT NULL) AS current_groups,
       SUM(m.module_code IS NULL)     AS old_codes_not_in_menu
  FROM role_permissions rp LEFT JOIN app_modules m ON m.module_code = rp.module_code
 GROUP BY rp.role_name ORDER BY rp.role_name;
SELECT DISTINCT rp.module_code AS old_code_not_in_menu
  FROM role_permissions rp LEFT JOIN app_modules m ON m.module_code = rp.module_code
 WHERE m.module_code IS NULL ORDER BY 1;
