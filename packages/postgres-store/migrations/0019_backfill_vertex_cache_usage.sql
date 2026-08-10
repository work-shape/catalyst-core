WITH eligible_usage AS (
  SELECT
    id,
    round(
      input_tokens *
      (customer_billable_cost #>> '{appliedRates,uncachedInputPricePerMillionTokens}')::numeric
    )::integer AS uncached_input_cost_micros,
    coalesce(
      (customer_billable_cost #>> '{knownComponents,outputCostMicros}')::integer,
      round(
        output_tokens *
        (customer_billable_cost #>> '{appliedRates,outputPricePerMillionTokens}')::numeric
      )::integer
    ) AS output_cost_micros,
    coalesce(
      (customer_billable_cost #>> '{knownComponents,webSearchCostMicros}')::integer,
      0
    ) AS web_search_cost_micros
  FROM model_usage_events
  WHERE provider_id = 'google-vertex'
    AND cached_input_tokens IS NULL
    AND customer_billable_cost ->> 'status' = 'incomplete'
    AND customer_billable_cost -> 'missingMeters' = '["cached_input_tokens"]'::jsonb
    AND customer_billable_cost #>> '{appliedRates,uncachedInputPricePerMillionTokens}' IS NOT NULL
    AND customer_billable_cost #>> '{appliedRates,outputPricePerMillionTokens}' IS NOT NULL
)
UPDATE model_usage_events AS usage
SET
  cached_input_tokens = 0,
  customer_billable_cost =
    usage.customer_billable_cost
      - 'knownComponents'
      - 'knownCostMicros'
      - 'missingMeters'
    || jsonb_build_object(
      'status', 'settled',
      'components', jsonb_build_object(
        'uncachedInputCostMicros', eligible.uncached_input_cost_micros,
        'cachedInputCostMicros', 0,
        'outputCostMicros', eligible.output_cost_micros,
        'webSearchCostMicros', eligible.web_search_cost_micros
      ),
      'totalCostMicros',
        eligible.uncached_input_cost_micros
        + eligible.output_cost_micros
        + eligible.web_search_cost_micros
    )
FROM eligible_usage AS eligible
WHERE usage.id = eligible.id;
