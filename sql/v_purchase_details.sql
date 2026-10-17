CREATE OR REPLACE VIEW v_purchase_details AS
SELECT
    x.SRC,                              -- 'S' = stock, 'N' = non-stock
    x.PJV_NO, x.PJV_DATE, x.SUP_CODE, s.SUP_NAME,
    x.ITEM_CODE, x.ITEM_NAME, x.QTY, x.ITEM_UNIT, x.COST,
    x.AMOUNT,
    ROUND(x.DISC, 2)                                      AS DISC_AMT,
    ROUND(x.AMOUNT - x.DISC, 2)                           AS TAXABLE_AMT,
    x.VAT_PERC,
    ROUND((x.AMOUNT - x.DISC) * x.VAT_PERC / 100, 2)      AS VAT_AMOUNT,
    ROUND((x.AMOUNT - x.DISC) * (1 + x.VAT_PERC / 100), 2) AS NET_AMOUNT
FROM (
    /* ---------- Stock purchases ---------- */
    SELECT
        'S'                         AS SRC,
        h.PJV_NO, h.PJV_DATE, h.SUP_CODE,
        i.ITEM_CODE,
        im.ITEM_NAME1               AS ITEM_NAME,
        i.QTY, i.ITEM_UNIT,
        i.COST                      AS COST,
        i.QTY * i.COST              AS AMOUNT,
        IFNULL(h.VAT_PERC, 0)       AS VAT_PERC,
        -- header discount shared out across lines by value
        IFNULL(IFNULL(h.DISCOUNT,0) * (i.QTY * i.COST)
               / NULLIF(SUM(i.QTY * i.COST) OVER (PARTITION BY h.PJV_NO), 0), 0) AS DISC
    FROM purchase_hdr h
    JOIN purchase_items i   ON i.SRV_NO     = h.PJV_NO
    LEFT JOIN item_mst im   ON im.ITEM_CODE = i.ITEM_CODE

    UNION ALL

    /* ---------- Non-stock purchases ---------- */
    SELECT
        'N'                         AS SRC,
        h.PJV_NO, h.PJV_DATE, h.SUP_CODE,
        i.ITEM_CODE,
        COALESCE(im.ITEM_NAME1, i.SUP_ITEM_DESC) AS ITEM_NAME,
        i.QTY, i.ITEM_UNIT,
        i.UNIT_COST                 AS COST,
        i.QTY * i.UNIT_COST         AS AMOUNT,
        IFNULL(i.VAT_PERC, 0)       AS VAT_PERC,   -- line-level VAT %
        IFNULL(i.DISCOUNT, 0)       AS DISC        -- line-level discount
    FROM purchase_hdr_ns h
    JOIN purchase_items_ns i ON i.PJV_NO     = h.PJV_NO
    LEFT JOIN item_mst im    ON im.ITEM_CODE = i.ITEM_CODE
) x
LEFT JOIN sup_mst s ON s.SUP_CODE = x.SUP_CODE;