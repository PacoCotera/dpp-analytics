-- Advertising V2 Batch 3 begins with deterministic, non-prescriptive shadow
-- diagnostics. These rules record production candidates for backtest and human
-- review; SHADOW lifecycle prevents them from entering the operator queue.

WITH rule(rule_key,lane,action_class,definition) AS (
    VALUES
    (
      'ADS_DATA_BLOCKER','PROTECT','INVESTIGATE',
      jsonb_build_object(
        'operator_problem','Can any Advertising recommendation be trusted?',
        'permitted_action_class','INVESTIGATE',
        'subject_grains',jsonb_build_array('MARKETPLACE_SOURCE'),
        'source_grains',jsonb_build_array('SOURCE_RUN','ACCOUNT_DAY_RECONCILIATION','OPERATING_WINDOW'),
        'compatible_windows',jsonb_build_array('ADS_FINALIZED_T28','CURRENT_SOURCE_STATE'),
        'exact_inputs',jsonb_build_object(
          'trusted','Canonical source coverage, reconciliation and finality contract is true.',
          'untrusted','Missing, partial, failed, stale or unreconciled governing source state.'
        ),
        'monetary_bases',jsonb_build_object(
          'materiality','Zero while evidence is untrusted; the rule must not invent financial impact.',
          'currency','Marketplace currency carried only to satisfy the shared materiality contract.'
        ),
        'eligibility',jsonb_build_object('operator','Source trusted flag is false.'),
        'exclusions',jsonb_build_object('operator','A healthy stored window is not invalidated solely by a later refresh failure.'),
        'thresholds',jsonb_build_object('trusted',false,'boundary_operator','='),
        'maturity_finality',jsonb_build_object('requirement','Use the affected downstream rule source contract.'),
        'economic_state_requirement','NONE',
        'cross_domain_guardrails',jsonb_build_array('Block only rules dependent on the affected source or subject.'),
        'materiality',jsonb_build_object('truth_class','OBSERVED_EXPOSURE','amount',0,'claim','No monetary impact claimed.'),
        'confidence',jsonb_build_object('HIGH','Direct canonical source state.'),
        'conflict_priority',1,
        'expiration_policy',jsonb_build_object('hours',24,'clear_when','A newer trusted source contract supersedes the blocker.'),
        'destination',jsonb_build_object('route','/data-health','view','advertising'),
        'outcome_metric','Affected source returns to a trusted state.',
        'evaluation_window','Next source/reconciliation refresh.',
        'rationale','Repair or inspect the named source before relying on dependent Advertising advice.',
        'prohibited_claims',jsonb_build_array('lost profit','incremental sales','account-wide invalidity from a subject-scoped defect'),
        'test_contract',jsonb_build_array('source-empty versus source-failed','stored healthy window with failed refresh','subject-scoped blocker')
      )
    ),
    (
      'ADS_INVENTORY_CONFLICT','PROTECT','INVESTIGATE',
      jsonb_build_object(
        'operator_problem','Is paid support creating demand DPP cannot currently fulfill?',
        'permitted_action_class','INVESTIGATE',
        'subject_grains',jsonb_build_array('CANONICAL_CURRENT_OFFER'),
        'source_grains',jsonb_build_array('ADS_PRODUCT_T28','CURRENT_INVENTORY_OFFER'),
        'compatible_windows',jsonb_build_array('ADS_FINALIZED_T28','CURRENT_INVENTORY_SNAPSHOT'),
        'exact_inputs',jsonb_build_object(
          'is_offer_owner',true,'inventory_action',jsonb_build_array('STOCKOUT','PRODUCE','PLAN'),
          'spend','> 0','minimum_observed_ads_days',14,
          'required_mature_days','observed_ads_days - attribution_lookback_days',
          'ads_window_trusted',true
        ),
        'monetary_bases',jsonb_build_object(
          'materiality','Observed Amazon Ads product spend overlapping the constraint.',
          'claim','Exposure only; not lost contribution or incrementality.'
        ),
        'eligibility',jsonb_build_object(
          'operator','current offer AND constrained inventory action AND spend > 0 AND trusted/finalized evidence'
        ),
        'exclusions',jsonb_build_object(
          'operator','Non-current owners are suppressed; unconstrained or zero-spend products produce no candidate.'
        ),
        'thresholds',jsonb_build_object(
          'minimum_spend',0,'spend_operator','>','minimum_observed_ads_days',14,'observed_days_operator','>='
        ),
        'threshold_source','Existing V1 observational boundary retained only for shadow validation; not approved capital policy.',
        'maturity_finality',jsonb_build_object('operator','mature_ads_days >= observed_ads_days - attribution_lookback_days'),
        'economic_state_requirement','NONE_FOR_INVESTIGATION',
        'cross_domain_guardrails',jsonb_build_array(
          'Do not recommend increasing support while inventory is constrained.',
          'Do not prescribe bid, budget, or pause changes without economics and action policy.'
        ),
        'materiality',jsonb_build_object('truth_class','OBSERVED_EXPOSURE','field','ads.product.spend'),
        'confidence',jsonb_build_object(
          'HIGH','Current owner, trusted Ads window, and final attribution.',
          'LOW','Candidate is recorded but suppressed when a governing condition fails.'
        ),
        'conflict_priority',2,
        'expiration_policy',jsonb_build_object('hours',24,'supersede_on','window, inventory, ownership, or trust change'),
        'destination',jsonb_build_object('route','/ads','view','decisions'),
        'outcome_metric','Inventory constraint and paid-support overlap is reviewed and later re-evaluated.',
        'evaluation_window','Next Ads or Inventory snapshot.',
        'rationale','Review replenishment and campaign intent while a current product has paid support and constrained stock.',
        'prohibited_claims',jsonb_build_array('pause now','reduce spend','lost profit','incremental demand'),
        'test_contract',jsonb_build_array('boundary spend zero','every inventory action','immature days','alias/deleted owner','untrusted Ads')
      )
    ),
    (
      'ADS_PRODUCT_CONVERSION_GAP','ELIMINATE','INVESTIGATE',
      jsonb_build_object(
        'operator_problem','Does paid traffic fail at the product conversion stage?',
        'permitted_action_class','INVESTIGATE',
        'subject_grains',jsonb_build_array('CANONICAL_CURRENT_OFFER'),
        'source_grains',jsonb_build_array('ADS_PRODUCT_T28','PRODUCT_TRAFFIC_T28','CURRENT_LISTING'),
        'compatible_windows',jsonb_build_array('ADS_FINALIZED_T28','CURRENT_LISTING_SNAPSHOT'),
        'exact_inputs',jsonb_build_object(
          'minimum_clicks',8,'click_operator','>=','attributed_purchases',0,'purchase_operator','=',
          'spend','> 0','minimum_observed_ads_days',14,
          'required_mature_days','observed_ads_days - attribution_lookback_days',
          'ads_window_trusted',true,'product_context',jsonb_build_array('sessions','listing_status')
        ),
        'monetary_bases',jsonb_build_object(
          'materiality','Observed Amazon Ads product spend associated with the diagnostic.',
          'attribution','Amazon-attributed purchases are not incremental purchases.',
          'claim','Exposure only; not contribution loss.'
        ),
        'eligibility',jsonb_build_object(
          'operator','clicks >= 8 AND attributed purchases = 0 AND spend > 0 AND current/trusted/final evidence'
        ),
        'exclusions',jsonb_build_object(
          'operator','Below-boundary traffic and any attributed purchase produce no candidate; unsafe ownership or evidence suppresses.'
        ),
        'thresholds',jsonb_build_object(
          'minimum_clicks',8,'click_operator','>=','maximum_attributed_purchases',0,'purchase_operator','=',
          'minimum_observed_ads_days',14,'observed_days_operator','>='
        ),
        'threshold_source','Existing V1 observational boundary retained only for shadow validation; not approved capital policy.',
        'maturity_finality',jsonb_build_object('operator','mature_ads_days >= observed_ads_days - attribution_lookback_days'),
        'economic_state_requirement','NONE_FOR_INVESTIGATION',
        'cross_domain_guardrails',jsonb_build_array(
          'Inspect product detail, price, offer, delivery, relevance, and listing state before advertising changes.',
          'No profitability, incrementality, or spend-change claim.'
        ),
        'materiality',jsonb_build_object('truth_class','OBSERVED_EXPOSURE','field','ads.product.spend'),
        'confidence',jsonb_build_object(
          'HIGH','Current owner, trusted Ads window, sufficient days, and final attribution.',
          'LOW','Candidate is recorded but suppressed when a governing condition fails.'
        ),
        'conflict_priority',4,
        'expiration_policy',jsonb_build_object('hours',24,'supersede_on','window, response, listing, ownership, or trust change'),
        'destination',jsonb_build_object('route','/ads','view','decisions'),
        'outcome_metric','Named product or relevance cause is reviewed; a later rule version may define a controlled test.',
        'evaluation_window','Next finalized Ads window after investigation.',
        'rationale','Investigate why sufficiently observed paid clicks have no Amazon-attributed purchase before changing media.',
        'prohibited_claims',jsonb_build_array('wasted spend','unprofitable','incremental sales','lower bids','pause campaign'),
        'test_contract',jsonb_build_array('clicks 7/8','purchases 0/1','immature days','missing product context','untrusted Ads')
      )
    )
), inserted AS (
    INSERT INTO decision.rule_definition(
        rule_key,rule_version,domain,kind,lane,permitted_action_class,
        definition_status,definition,definition_sha256
    )
    SELECT rule_key,2,'ADVERTISING',rule_key,lane,action_class,'COMPLETE',definition,
           encode(sha256(convert_to(definition::text,'UTF8')),'hex')
    FROM rule
    RETURNING rule_key,rule_version
), drafted AS (
    INSERT INTO decision.rule_lifecycle_event(
        rule_key,rule_version,from_lifecycle,to_lifecycle,reason,actor
    )
    SELECT rule_key,rule_version,NULL,'DRAFT',
           'Complete Batch 3 observational definition registered for production shadow validation.',
           'migration:074'
    FROM inserted
    RETURNING rule_key,rule_version
)
INSERT INTO decision.rule_lifecycle_event(
    rule_key,rule_version,from_lifecycle,to_lifecycle,reason,actor
)
SELECT rule_key,rule_version,'DRAFT','SHADOW',
       'Evaluate and persist production facts without exposing an operator action.',
       'migration:074'
FROM drafted;

COMMENT ON FUNCTION decision.validate_candidate_snapshot_rule() IS
'Serializes candidate persistence with lifecycle changes and rejects facts evaluated under a stale rule lifecycle.';
