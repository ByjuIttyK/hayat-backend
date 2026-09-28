-- =====================================================================
--  access_rights_demo_roles.sql  -  DEMO ONLY (database mfg)
--  Sample department roles so prospects can see access rights in use.
--  Do NOT run on production. Run after access_rights_step1.sql.
-- =====================================================================
INSERT IGNORE INTO roles (role_name, remarks) VALUES
 ('accounts', 'Accounts team - G/L, receipts, payments, fixed assets'),
 ('sales',    'Sales team - enquiries, quotations, orders, invoices'),
 ('purchase', 'Purchase team - LPO/FPO, purchase invoices, returns'),
 ('stores',   'Stores team - SRV, SIV, stock adjustment, transfers');

DROP PROCEDURE IF EXISTS grant_groups;
DELIMITER //
-- p_full = 'Y': view + add/edit/post on entry screens (no delete); 'N': view only
CREATE PROCEDURE grant_groups(IN p_role VARCHAR(50), IN p_groups TEXT, IN p_full CHAR(1))
BEGIN
  INSERT INTO role_permissions (role_name, module_code, can_view, can_add, can_edit, can_delete, can_post)
  SELECT p_role, module_code, 'Y',
         IF(p_full='Y', is_entry, 'N'), IF(p_full='Y', is_entry, 'N'), 'N', IF(p_full='Y', is_entry, 'N')
    FROM app_modules
   WHERE FIND_IN_SET(menu_group, p_groups) AND module_code NOT IN ('USERMGMT','ACCESSRIGHTS')
  ON DUPLICATE KEY UPDATE can_view='Y';
END//
DELIMITER ;

CALL grant_groups('accounts', 'Gen.Ledger,Fixed Assets', 'Y');
CALL grant_groups('accounts', 'Masters,Sales,Purchase,Analytics', 'N');
CALL grant_groups('sales',    'Sales', 'Y');
CALL grant_groups('sales',    'Masters,Inventory,Manufacturing Jobs', 'N');
CALL grant_groups('purchase', 'Purchase', 'Y');
CALL grant_groups('purchase', 'Masters,Inventory', 'N');
CALL grant_groups('stores',   'Inventory', 'Y');
CALL grant_groups('stores',   'Masters,Manufacturing Jobs', 'N');
DROP PROCEDURE grant_groups;

SELECT role_name, COUNT(*) AS screens, SUM(can_add='Y') AS with_add FROM role_permissions GROUP BY role_name;
