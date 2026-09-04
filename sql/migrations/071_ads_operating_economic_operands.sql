-- Advertising V2 economic operands remain independent from UI/reporting code.
-- These views preserve exact source relationships and visible residuals. They do
-- not claim product contribution: seller COGS and validated fee classifications
-- remain required inputs to the canonical server-owned economic contract.

CREATE VIEW mart.finance_product_allocation_daily AS
WITH item AS (
    SELECT
        transaction.marketplace_id,
        (transaction.posted_date AT TIME ZONE marketplace.timezone)::date AS business_date,
        transaction.transaction_id,
        transaction.transaction_type,
        transaction.total_amount AS transaction_amount,
        finance_item.item_ordinal,
        finance_item.total_amount AS item_amount,
        identity.identity_state,
        identity.seller_sku AS source_sku,
        identity.asin AS source_asin,
        owner.seller_sku,
        owner.asin,
        owner.catalog_membership,
        owner.is_offer_owner
    FROM core.financial_transaction transaction
    JOIN core.marketplace marketplace USING (marketplace_id)
    JOIN core.financial_transaction_item finance_item USING (transaction_id)
    JOIN mart.finance_transaction_item_identity identity
      USING (transaction_id,item_ordinal)
    LEFT JOIN LATERAL (
        SELECT product.seller_sku,product.asin,product.catalog_membership,
               product.is_offer_owner
        FROM mart.catalog_portfolio_product product
        WHERE product.marketplace_id=transaction.marketplace_id
          AND product.is_offer_owner
          AND product.catalog_membership='CURRENT_OFFER'
          AND product.asin=identity.asin
        ORDER BY product.seller_sku
        LIMIT 1
    ) owner ON true
    WHERE transaction.transaction_status='RELEASED'
      AND transaction.posted_date IS NOT NULL
      AND transaction.transaction_type IN (
          'Shipment','Refund','ServiceFee','Adjustment',
          'MiscellaneousLedgerAdjustment','FBAInventoryReimbursement'
      )
)
SELECT
    marketplace_id,business_date,seller_sku,asin,
    count(*)::bigint AS finance_item_rows,
    count(*) FILTER (WHERE identity_state='EXACT')::bigint AS exact_identity_rows,
    count(*) FILTER (
        WHERE identity_state='EXACT' AND is_offer_owner
          AND source_sku IS DISTINCT FROM seller_sku
    )::bigint AS canonicalized_alias_rows,
    sum(item_amount) FILTER (
        WHERE identity_state='EXACT' AND is_offer_owner
    )::numeric(18,4) AS allocated_finance_amount,
    sum(item_amount) FILTER (
        WHERE identity_state='EXACT' AND is_offer_owner
          AND source_sku IS DISTINCT FROM seller_sku
    )::numeric(18,4) AS canonicalized_alias_amount,
    sum(item_amount) FILTER (
        WHERE identity_state='EXACT' AND is_offer_owner
          AND transaction_type IN ('Shipment','Refund')
    )::numeric(18,4) AS allocated_order_finance_amount,
    sum(item_amount) FILTER (
        WHERE identity_state='EXACT' AND is_offer_owner
          AND transaction_type IN (
              'ServiceFee','Adjustment','MiscellaneousLedgerAdjustment',
              'FBAInventoryReimbursement'
          )
    )::numeric(18,4) AS allocated_other_amazon_postings,
    string_agg(DISTINCT transaction_type,',' ORDER BY transaction_type)
        FILTER (WHERE identity_state='EXACT' AND is_offer_owner)
        AS included_transaction_types
FROM item
WHERE is_offer_owner
GROUP BY marketplace_id,business_date,seller_sku,asin;

CREATE VIEW mart.finance_business_allocation_daily AS
WITH transaction_total AS (
    SELECT
        transaction.marketplace_id,
        (transaction.posted_date AT TIME ZONE marketplace.timezone)::date AS business_date,
        sum(transaction.total_amount) FILTER (
            WHERE transaction.transaction_type IN (
                'Shipment','Refund','ServiceFee','Adjustment',
                'MiscellaneousLedgerAdjustment','FBAInventoryReimbursement'
            )
        )::numeric(18,4) AS included_finance_amount,
        sum(transaction.total_amount) FILTER (
            WHERE transaction.transaction_type IN ('Shipment','Refund')
        )::numeric(18,4) AS order_finance_amount,
        sum(transaction.total_amount) FILTER (
            WHERE transaction.transaction_type IN (
                'ServiceFee','Adjustment','MiscellaneousLedgerAdjustment',
                'FBAInventoryReimbursement'
            )
        )::numeric(18,4) AS other_amazon_postings,
        sum(transaction.total_amount) FILTER (
            WHERE transaction.transaction_type='ProductAdsPayment'
        )::numeric(18,4) AS finance_advertising_expense,
        sum(transaction.total_amount) FILTER (
            WHERE transaction.transaction_type NOT IN (
                'Shipment','Refund','ServiceFee','Adjustment',
                'MiscellaneousLedgerAdjustment','FBAInventoryReimbursement',
                'ProductAdsPayment','Transfer','DebtRecovery','AdhocDisbursement'
            )
        )::numeric(18,4) AS unclassified_operating_amount
    FROM core.financial_transaction transaction
    JOIN core.marketplace marketplace USING (marketplace_id)
    WHERE transaction.transaction_status='RELEASED'
      AND transaction.posted_date IS NOT NULL
    GROUP BY transaction.marketplace_id,2
), allocated AS (
    SELECT marketplace_id,business_date,
           sum(allocated_finance_amount)::numeric(18,4) AS allocated_product_amount
    FROM mart.finance_product_allocation_daily
    GROUP BY marketplace_id,business_date
)
SELECT
    total.marketplace_id,total.business_date,
    total.included_finance_amount,total.order_finance_amount,
    total.other_amazon_postings,total.finance_advertising_expense,
    total.unclassified_operating_amount,
    allocated.allocated_product_amount,
    (COALESCE(total.included_finance_amount,0)
      - COALESCE(allocated.allocated_product_amount,0))::numeric(18,4)
        AS product_allocation_residual
FROM transaction_total total
LEFT JOIN allocated USING (marketplace_id,business_date);

CREATE VIEW mart.ads_business_economic_operands_daily AS
WITH advertising AS (
    SELECT marketplace_id,business_date,
           sum(campaign_spend)::numeric(18,4) AS ads_analytical_spend,
           sum(product_spend)::numeric(18,4) AS ads_product_spend,
           sum(unassigned_product_spend)::numeric(18,4)
               AS ads_product_allocation_residual,
           bool_and(reconciliation_state='RECONCILED') AS ads_product_spend_reconciled
    FROM mart.ads_account_product_spend_reconciliation
    GROUP BY marketplace_id,business_date
)
SELECT
    sales.marketplace_id,sales.business_date,
    sales.ordered_product_sales::numeric(18,4) AS gross_seller_sales_incl_iva,
    round(sales.ordered_product_sales/(1+policy.standard_vat_rate),4)::numeric(18,4)
        AS net_seller_sales_ex_iva,
    (sales.ordered_product_sales
      - round(sales.ordered_product_sales/(1+policy.standard_vat_rate),4))::numeric(18,4)
        AS iva_on_sales,
    sales.units_ordered::bigint AS units,
    finance.order_finance_amount,finance.other_amazon_postings,
    finance.finance_advertising_expense,finance.unclassified_operating_amount,
    finance.allocated_product_amount,finance.product_allocation_residual,
    advertising.ads_analytical_spend,advertising.ads_product_spend,
    advertising.ads_product_allocation_residual,
    COALESCE(advertising.ads_product_spend_reconciled,false)
        AS ads_product_spend_reconciled,
    policy.standard_vat_rate,
    policy.sales_traffic_amount_basis,
    'FINANCE_POSTED_DATE'::text AS finance_period_basis,
    'AMAZON_ATTRIBUTED_RESPONSE_NOT_INCREMENTALITY'::text AS attribution_basis
FROM core.sales_traffic_daily sales
JOIN core.marketplace_tax_policy policy USING (marketplace_id)
LEFT JOIN mart.finance_business_allocation_daily finance
  USING (marketplace_id,business_date)
LEFT JOIN advertising USING (marketplace_id,business_date);

CREATE VIEW mart.ads_product_economic_operands_daily AS
SELECT
    sales.marketplace_id,sales.business_date,product.seller_sku,product.asin,
    sales.ordered_product_sales::numeric(18,4) AS gross_seller_sales_incl_iva,
    round(sales.ordered_product_sales/(1+policy.standard_vat_rate),4)::numeric(18,4)
        AS net_seller_sales_ex_iva,
    (sales.ordered_product_sales
      - round(sales.ordered_product_sales/(1+policy.standard_vat_rate),4))::numeric(18,4)
        AS iva_on_sales,
    sales.units_ordered::bigint AS units,
    product_finance.allocated_order_finance_amount,
    product_finance.allocated_other_amazon_postings,
    product_finance.included_transaction_types,
    product_ads.ad_spend::numeric(18,4) AS ads_analytical_spend,
    business_finance.product_allocation_residual,
    business_ads.ads_product_allocation_residual,
    COALESCE(business_ads.ads_product_spend_reconciled,false)
        AS ads_product_spend_reconciled,
    policy.standard_vat_rate,
    policy.sales_traffic_amount_basis,
    'CHILD_ASIN_CANONICAL_OFFER_OWNER'::text AS sales_identity_basis,
    'FINANCE_POSTED_DATE'::text AS finance_period_basis,
    'AMAZON_ATTRIBUTED_RESPONSE_NOT_INCREMENTALITY'::text AS attribution_basis
FROM core.asin_sales_traffic_daily sales
JOIN mart.catalog_portfolio_product product
  ON product.marketplace_id=sales.marketplace_id
 AND product.asin=sales.asin
 AND product.is_offer_owner
 AND product.catalog_membership='CURRENT_OFFER'
JOIN core.marketplace_tax_policy policy
  ON policy.marketplace_id=sales.marketplace_id
LEFT JOIN mart.finance_product_allocation_daily product_finance
  ON product_finance.marketplace_id=sales.marketplace_id
 AND product_finance.business_date=sales.business_date
 AND product_finance.seller_sku=product.seller_sku
 AND product_finance.asin=product.asin
LEFT JOIN mart.finance_business_allocation_daily business_finance
  ON business_finance.marketplace_id=sales.marketplace_id
 AND business_finance.business_date=sales.business_date
LEFT JOIN mart.ads_product_business_daily product_ads
  ON product_ads.marketplace_id=sales.marketplace_id
 AND product_ads.business_date=sales.business_date
 AND product_ads.sku=product.seller_sku
 AND product_ads.asin=product.asin
LEFT JOIN mart.ads_business_economic_operands_daily business_ads
  ON business_ads.marketplace_id=sales.marketplace_id
 AND business_ads.business_date=sales.business_date;

COMMENT ON VIEW mart.finance_product_allocation_daily IS
'Exact Finance item totals assigned only when Finance provides exact SKU+ASIN identity and Catalog resolves that ASIN to the current canonical offer owner. Historical SKU aliases remain counted explicitly. No revenue- or unit-proportional allocation is permitted.';

COMMENT ON VIEW mart.finance_business_allocation_daily IS
'Business-level signed Finance operands and product-allocation residual. Transfers, debt recovery and disbursements are cash timing; ProductAdsPayment is exposed separately and never added to Ads analytical spend.';

COMMENT ON VIEW mart.ads_business_economic_operands_daily IS
'Canonical daily business operands for Advertising V2. Gross Sales & Traffic money, explicit IVA transform, Finance posted-date effects, Ads analytical spend and all allocation residuals stay separate.';

COMMENT ON VIEW mart.ads_product_economic_operands_daily IS
'Canonical daily product operands for Advertising V2 at current offer-owner CHILD-ASIN grain. COGS and proven fee subcategories remain absent until supplied by the server contract; therefore this view alone never authorizes product contribution.';
