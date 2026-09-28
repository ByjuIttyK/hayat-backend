-- =====================================================================
--  company_table.sql — logo file names in the company table.
--  Everything else (name, address, phone, e-mail, web site) comes from the
--  existing columns of the same row.
--
--  Run once on each database:
--    laptop / production (hayat):  mysql -u root -p hayat < company_table.sql
--    demo (MilesWeb, mfg):         sudo mysql mfg < company_table.sql
-- =====================================================================

-- The 4 name columns from the first version are not needed — remove them
-- (skipped automatically if they were never added).
DROP PROCEDURE IF EXISTS co_drop_col;
DELIMITER //
CREATE PROCEDURE co_drop_col(IN c VARCHAR(64))
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'company' AND COLUMN_NAME = c) THEN
    SET @s = CONCAT('ALTER TABLE company DROP COLUMN ', c);
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END//
CREATE PROCEDURE co_add_col(IN c VARCHAR(64), IN def VARCHAR(200))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'company' AND COLUMN_NAME = c) THEN
    SET @s = CONCAT('ALTER TABLE company ADD COLUMN ', c, ' ', def);
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END//
DELIMITER ;

CALL co_drop_col('SHORT_NAME');
CALL co_drop_col('TITLE_NAME');
CALL co_drop_col('PRINT_LINE1');
CALL co_drop_col('PRINT_LINE2');

CALL co_add_col('LOGO_FILENAME',     'VARCHAR(30) NULL COMMENT ''logo file in the frontend public folder, e.g. HayatLogo.jpg''');
CALL co_add_col('INV_LOGO_FILENAME', 'VARCHAR(30) NULL COMMENT ''header image on printed invoices (blank = LOGO_FILENAME)''');

DROP PROCEDURE co_drop_col;
DROP PROCEDURE co_add_col;

-- ── Al Hayat (laptop + production database `hayat`) ────────────────────
UPDATE company SET LOGO_FILENAME = 'HayatLogo.jpg', INV_LOGO_FILENAME = 'HayatInv.jpg'
 WHERE CMP_CODE = 'I';

-- ── Demo (database `mfg`) — anonymize_mfg.sql sets these for the demo:
--    NAME, PLACE, ADDRESS1/2, PHONE, EMAIL, WEB_SITE,
--    LOGO_FILENAME = 'DemoLogo.jpg', INV_LOGO_FILENAME = 'DemoInv.jpg'

SELECT * FROM company;
