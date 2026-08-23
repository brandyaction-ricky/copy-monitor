-- ICT Trading Decision Engine v2
-- PostgreSQL 14+ / Supabase
--
-- Additive migration: all objects live in the isolated `ict_v2` schema so the
-- current application can keep running while v2 is evaluated in shadow mode.
-- All timestamps are timestamptz and must be written in UTC by the producer.

begin;

create extension if not exists pgcrypto;
create schema if not exists ict_v2;
comment on schema ict_v2 is
  'Versioned, as-of-safe persistence for the ICT trading decision engine.';

do $$
begin
  create type ict_v2.direction as enum ('BULLISH', 'BEARISH', 'NEUTRAL');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type ict_v2.feature_status as enum
    ('CANDIDATE', 'CONFIRMED', 'MITIGATED', 'INVALIDATED', 'EXPIRED');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type ict_v2.sweep_state as enum
    ('RAID', 'RECLAIMED', 'CONFIRMED', 'FAILED', 'BREAKOUT');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type ict_v2.setup_state as enum (
    'SCANNING',
    'LOCATION_FOUND',
    'LIQUIDITY_TARGET_FOUND',
    'RAID_DETECTED',
    'SWEEP_CONFIRMED',
    'WAITING_CISD',
    'CISD_CONFIRMED',
    'WAITING_DISPLACEMENT',
    'DISPLACEMENT_CONFIRMED',
    'INTERNAL_BREAK_CONFIRMED',
    'WAITING_MSS',
    'MSS_CONFIRMED',
    'WAITING_RETRACE',
    'ENTRY_READY',
    'POSITION_OPEN',
    'INVALIDATED',
    'EXPIRED',
    'NO_TRADE'
  );
exception when duplicate_object then null;
end $$;

do $$
begin
  create type ict_v2.trading_decision as enum
    ('LONG', 'SHORT', 'WAIT', 'NO_TRADE');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type ict_v2.entry_mode as enum
    ('AGGRESSIVE', 'BALANCED', 'CONSERVATIVE');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type ict_v2.lifecycle_status as enum
    ('DRAFT', 'SHADOW', 'ACTIVE', 'RETIRED');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type ict_v2.run_status as enum
    ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type ict_v2.trade_status as enum
    ('PLANNED', 'OPEN', 'CLOSED', 'CANCELLED', 'REJECTED');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type ict_v2.execution_environment as enum
    ('SHADOW', 'PAPER', 'LIVE', 'BACKTEST');
exception when duplicate_object then null;
end $$;

create table if not exists ict_v2.model_versions (
  id uuid primary key default gen_random_uuid(),
  model_key text not null,
  semantic_version text not null,
  algorithm_version text not null,
  status ict_v2.lifecycle_status not null default 'DRAFT',
  manifest jsonb not null default '{}'::jsonb,
  code_commit_sha text,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  retired_at timestamptz,
  constraint model_versions_model_key_nonempty check (btrim(model_key) <> ''),
  constraint model_versions_semver_nonempty check (btrim(semantic_version) <> ''),
  constraint model_versions_algorithm_nonempty check (btrim(algorithm_version) <> ''),
  constraint model_versions_manifest_object check (jsonb_typeof(manifest) = 'object'),
  constraint model_versions_lifecycle_order check (
    (activated_at is null or activated_at >= created_at)
    and (retired_at is null or retired_at >= coalesce(activated_at, created_at))
  ),
  constraint model_versions_key_version_unique unique (model_key, semantic_version),
  constraint model_versions_algorithm_unique unique (algorithm_version),
  constraint model_versions_id_algorithm_unique unique (id, algorithm_version)
);

create unique index if not exists model_versions_one_active_per_model_idx
  on ict_v2.model_versions (model_key)
  where status = 'ACTIVE';

create table if not exists ict_v2.parameter_sets (
  id uuid primary key default gen_random_uuid(),
  model_version_id uuid not null references ict_v2.model_versions(id),
  name text not null,
  version integer not null,
  status ict_v2.lifecycle_status not null default 'DRAFT',
  parameters jsonb not null,
  checksum text not null,
  effective_from timestamptz,
  created_at timestamptz not null default now(),
  created_by text,
  constraint parameter_sets_name_nonempty check (btrim(name) <> ''),
  constraint parameter_sets_version_positive check (version > 0),
  constraint parameter_sets_parameters_object check (jsonb_typeof(parameters) = 'object'),
  constraint parameter_sets_checksum_nonempty check (btrim(checksum) <> ''),
  constraint parameter_sets_name_version_unique unique (model_version_id, name, version),
  constraint parameter_sets_checksum_unique unique (model_version_id, checksum),
  constraint parameter_sets_id_model_unique unique (id, model_version_id)
);

create unique index if not exists parameter_sets_one_active_name_idx
  on ict_v2.parameter_sets (model_version_id, name)
  where status = 'ACTIVE';

create table if not exists ict_v2.market_candles (
  id uuid primary key default gen_random_uuid(),
  exchange text not null,
  symbol text not null,
  timeframe text not null,
  open_time timestamptz not null,
  close_time timestamptz not null,
  open numeric(28, 10) not null,
  high numeric(28, 10) not null,
  low numeric(28, 10) not null,
  close numeric(28, 10) not null,
  volume numeric(38, 10),
  is_closed boolean not null default false,
  ingested_at timestamptz not null default now(),
  source_payload_hash text,
  constraint market_candles_identity_nonempty check (
    btrim(exchange) <> '' and btrim(symbol) <> '' and btrim(timeframe) <> ''
  ),
  constraint market_candles_time_order check (close_time > open_time),
  constraint market_candles_prices_positive check (
    open > 0 and high > 0 and low > 0 and close > 0
  ),
  constraint market_candles_ohlc_valid check (
    high >= greatest(open, close, low)
    and low <= least(open, close, high)
  ),
  constraint market_candles_volume_nonnegative check (volume is null or volume >= 0),
  constraint market_candles_natural_key unique (exchange, symbol, timeframe, open_time)
);

create index if not exists market_candles_closed_lookup_idx
  on ict_v2.market_candles (exchange, symbol, timeframe, close_time desc)
  where is_closed;

-- Derived values such as ATR are versioned separately from immutable OHLCV.
create table if not exists ict_v2.candle_indicators (
  id uuid primary key default gen_random_uuid(),
  candle_id uuid not null references ict_v2.market_candles(id),
  model_version_id uuid not null,
  parameter_set_id uuid not null,
  algorithm_version text not null,
  indicator_name text not null,
  indicator_value numeric(38, 12) not null,
  as_of_time timestamptz not null,
  calculated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  constraint candle_indicators_model_algorithm_fk
    foreign key (model_version_id, algorithm_version)
    references ict_v2.model_versions(id, algorithm_version),
  constraint candle_indicators_parameter_model_fk
    foreign key (parameter_set_id, model_version_id)
    references ict_v2.parameter_sets(id, model_version_id),
  constraint candle_indicators_name_nonempty check (btrim(indicator_name) <> ''),
  constraint candle_indicators_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint candle_indicators_natural_key unique
    (candle_id, parameter_set_id, algorithm_version, indicator_name)
);

create table if not exists ict_v2.market_features (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null,
  model_version_id uuid not null,
  parameter_set_id uuid not null,
  algorithm_version text not null,
  exchange text not null,
  symbol text not null,
  timeframe text not null,
  feature_type text not null,
  direction ict_v2.direction,
  status ict_v2.feature_status not null,
  detected_at timestamptz not null,
  confirmed_at timestamptz,
  as_of_time timestamptz not null,
  start_time timestamptz,
  end_time timestamptz,
  source_candle_id uuid references ict_v2.market_candles(id),
  price_high numeric(28, 10),
  price_low numeric(28, 10),
  reference_price numeric(28, 10),
  quality_score numeric(6, 3) not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint market_features_model_algorithm_fk
    foreign key (model_version_id, algorithm_version)
    references ict_v2.model_versions(id, algorithm_version),
  constraint market_features_parameter_model_fk
    foreign key (parameter_set_id, model_version_id)
    references ict_v2.parameter_sets(id, model_version_id),
  constraint market_features_idempotency_nonempty check (btrim(idempotency_key) <> ''),
  constraint market_features_identity_nonempty check (
    btrim(exchange) <> '' and btrim(symbol) <> '' and btrim(timeframe) <> ''
    and btrim(feature_type) <> ''
  ),
  constraint market_features_score_range check (quality_score between 0 and 100),
  constraint market_features_price_range check (
    price_high is null or price_low is null or price_high >= price_low
  ),
  constraint market_features_detection_order check (
    confirmed_at is null or confirmed_at >= detected_at
  ),
  constraint market_features_asof_safe check (
    detected_at <= as_of_time
    and (confirmed_at is null or confirmed_at <= as_of_time)
    and (end_time is null or start_time is null or end_time >= start_time)
  ),
  constraint market_features_confirmed_timestamp check (
    status <> 'CONFIRMED' or confirmed_at is not null
  ),
  constraint market_features_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint market_features_idempotency_unique unique (idempotency_key)
);

create index if not exists market_features_asof_lookup_idx
  on ict_v2.market_features
  (exchange, symbol, timeframe, feature_type, as_of_time desc);
create index if not exists market_features_confirmed_lookup_idx
  on ict_v2.market_features
  (exchange, symbol, timeframe, confirmed_at desc)
  where confirmed_at is not null and status = 'CONFIRMED';
create index if not exists market_features_parameter_lookup_idx
  on ict_v2.market_features (parameter_set_id, algorithm_version, as_of_time desc);

create table if not exists ict_v2.swings (
  feature_id uuid primary key references ict_v2.market_features(id),
  pivot_time timestamptz not null,
  confirmed_at timestamptz not null,
  pivot_price numeric(28, 10) not null,
  hierarchy text not null,
  prominence_atr numeric(18, 8) not null,
  left_bars smallint not null,
  right_bars smallint not null,
  is_protected boolean not null default false,
  protected_by_feature_id uuid references ict_v2.market_features(id),
  constraint swings_price_positive check (pivot_price > 0),
  constraint swings_hierarchy_valid check (hierarchy in ('MICRO', 'INTERNAL', 'EXTERNAL')),
  constraint swings_prominence_nonnegative check (prominence_atr >= 0),
  constraint swings_window_positive check (left_bars > 0 and right_bars > 0),
  constraint swings_confirmation_after_pivot check (confirmed_at > pivot_time)
);

create index if not exists swings_confirmed_lookup_idx
  on ict_v2.swings (confirmed_at desc, hierarchy);

create table if not exists ict_v2.liquidity_levels (
  feature_id uuid primary key references ict_v2.market_features(id),
  source_swing_id uuid references ict_v2.swings(feature_id),
  level_type text not null,
  liquidity_side text not null,
  price numeric(28, 10) not null,
  tolerance_atr numeric(18, 8),
  touch_count integer not null default 1,
  strength_score numeric(6, 3) not null default 0,
  first_touch_at timestamptz,
  last_touch_at timestamptz,
  consumed_at timestamptz,
  constraint liquidity_levels_type_valid check (
    level_type in ('BSL', 'SSL', 'EQH', 'EQL', 'PDH', 'PDL', 'PWH', 'PWL', 'PMH', 'PML', 'ROUND_NUMBER')
  ),
  constraint liquidity_levels_side_valid check (liquidity_side in ('BUY_SIDE', 'SELL_SIDE')),
  constraint liquidity_levels_price_positive check (price > 0),
  constraint liquidity_levels_tolerance_nonnegative check (tolerance_atr is null or tolerance_atr >= 0),
  constraint liquidity_levels_touch_positive check (touch_count > 0),
  constraint liquidity_levels_score_range check (strength_score between 0 and 100),
  constraint liquidity_levels_touch_order check (
    last_touch_at is null or first_touch_at is null or last_touch_at >= first_touch_at
  )
);

create index if not exists liquidity_levels_price_idx
  on ict_v2.liquidity_levels (liquidity_side, price);

create table if not exists ict_v2.sweeps (
  feature_id uuid primary key references ict_v2.market_features(id),
  liquidity_level_id uuid not null references ict_v2.liquidity_levels(feature_id),
  state ict_v2.sweep_state not null,
  liquidity_side text not null,
  level_price numeric(28, 10) not null,
  extreme_price numeric(28, 10) not null,
  penetration_atr numeric(18, 8) not null,
  raid_at timestamptz not null,
  reclaim_at timestamptz,
  confirmed_at timestamptz,
  breakout_at timestamptz,
  reclaim_bars smallint,
  constraint sweeps_side_valid check (liquidity_side in ('BUY_SIDE', 'SELL_SIDE')),
  constraint sweeps_prices_positive check (level_price > 0 and extreme_price > 0),
  constraint sweeps_penetration_nonnegative check (penetration_atr >= 0),
  constraint sweeps_reclaim_bars_nonnegative check (reclaim_bars is null or reclaim_bars >= 0),
  constraint sweeps_event_order check (
    (reclaim_at is null or reclaim_at >= raid_at)
    and (confirmed_at is null or confirmed_at >= raid_at)
    and (breakout_at is null or breakout_at >= raid_at)
  ),
  constraint sweeps_reclaimed_timestamp check (
    state not in ('RECLAIMED', 'CONFIRMED') or reclaim_at is not null
  ),
  constraint sweeps_breakout_timestamp check (state <> 'BREAKOUT' or breakout_at is not null)
);

create index if not exists sweeps_level_state_idx
  on ict_v2.sweeps (liquidity_level_id, state, raid_at desc);

create table if not exists ict_v2.cisd_events (
  feature_id uuid primary key references ict_v2.market_features(id),
  sweep_id uuid references ict_v2.sweeps(feature_id),
  direction ict_v2.direction not null,
  delivery_before ict_v2.direction not null,
  anchor_candle_id uuid references ict_v2.market_candles(id),
  anchor_candle_time timestamptz not null,
  anchor_open numeric(28, 10) not null,
  confirmation_price numeric(28, 10) not null,
  confirmation_time timestamptz not null,
  bars_after_sweep smallint,
  close_beyond_anchor_atr numeric(18, 8) not null,
  displacement_after boolean not null default false,
  associated_fvg_id uuid,
  constraint cisd_events_directional check (
    direction in ('BULLISH', 'BEARISH') and delivery_before in ('BULLISH', 'BEARISH')
  ),
  constraint cisd_events_prices_positive check (anchor_open > 0 and confirmation_price > 0),
  constraint cisd_events_delay_nonnegative check (bars_after_sweep is null or bars_after_sweep >= 0),
  constraint cisd_events_break_nonnegative check (close_beyond_anchor_atr >= 0),
  constraint cisd_events_confirmation_order check (confirmation_time >= anchor_candle_time)
);

create index if not exists cisd_events_sweep_confirmation_idx
  on ict_v2.cisd_events (sweep_id, confirmation_time desc);

create table if not exists ict_v2.displacements (
  feature_id uuid primary key references ict_v2.market_features(id),
  prior_cisd_id uuid references ict_v2.cisd_events(feature_id),
  direction ict_v2.direction not null,
  candle_id uuid not null references ict_v2.market_candles(id),
  range_atr numeric(18, 8) not null,
  body_ratio numeric(9, 8) not null,
  displacement_score numeric(6, 3) not null,
  strong_close boolean not null,
  structure_break boolean not null,
  fvg_created boolean not null,
  after_liquidity_event boolean not null,
  constraint displacements_directional check (direction in ('BULLISH', 'BEARISH')),
  constraint displacements_range_nonnegative check (range_atr >= 0),
  constraint displacements_body_ratio_range check (body_ratio between 0 and 1),
  constraint displacements_score_range check (displacement_score between 0 and 100)
);

create index if not exists displacements_cisd_idx
  on ict_v2.displacements (prior_cisd_id);

create table if not exists ict_v2.structure_events (
  feature_id uuid primary key references ict_v2.market_features(id),
  event_type text not null,
  direction ict_v2.direction not null,
  prior_cisd_id uuid references ict_v2.cisd_events(feature_id),
  broken_swing_id uuid not null references ict_v2.swings(feature_id),
  broken_swing_price numeric(28, 10) not null,
  break_price numeric(28, 10) not null,
  close_beyond_swing_atr numeric(18, 8) not null,
  displacement_id uuid references ict_v2.displacements(feature_id),
  confirmed_at timestamptz not null,
  constraint structure_events_type_valid check (event_type in ('BOS', 'CHOCH', 'MSS')),
  constraint structure_events_directional check (direction in ('BULLISH', 'BEARISH')),
  constraint structure_events_prices_positive check (broken_swing_price > 0 and break_price > 0),
  constraint structure_events_break_nonnegative check (close_beyond_swing_atr >= 0),
  constraint structure_events_mss_provenance check (
    event_type <> 'MSS' or (prior_cisd_id is not null and displacement_id is not null)
  )
);

create index if not exists structure_events_cisd_confirmed_idx
  on ict_v2.structure_events (prior_cisd_id, confirmed_at desc);

create table if not exists ict_v2.pd_arrays (
  feature_id uuid primary key references ict_v2.market_features(id),
  array_type text not null,
  direction ict_v2.direction not null,
  price_high numeric(28, 10) not null,
  price_low numeric(28, 10) not null,
  consequent_encroachment numeric(28, 10),
  size_atr numeric(18, 8) not null,
  created_at timestamptz not null,
  mitigation_percent numeric(7, 4) not null default 0,
  is_valid boolean not null default true,
  invalidated_at timestamptz,
  displacement_id uuid references ict_v2.displacements(feature_id),
  structure_event_id uuid references ict_v2.structure_events(feature_id),
  constraint pd_arrays_type_valid check (array_type in ('FVG', 'OB', 'BPR', 'BREAKER')),
  constraint pd_arrays_directional check (direction in ('BULLISH', 'BEARISH')),
  constraint pd_arrays_price_range check (price_high > 0 and price_low > 0 and price_high >= price_low),
  constraint pd_arrays_ce_range check (
    consequent_encroachment is null
    or consequent_encroachment between price_low and price_high
  ),
  constraint pd_arrays_size_nonnegative check (size_atr >= 0),
  constraint pd_arrays_mitigation_range check (mitigation_percent between 0 and 100),
  constraint pd_arrays_invalidation_order check (invalidated_at is null or invalidated_at >= created_at)
);

create index if not exists pd_arrays_active_price_idx
  on ict_v2.pd_arrays (array_type, direction, price_low, price_high)
  where is_valid;

-- Circular provenance is added only after both CISD and PD Array tables exist.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'cisd_events_associated_fvg_fk'
      and conrelid = 'ict_v2.cisd_events'::regclass
  ) then
    alter table ict_v2.cisd_events
      add constraint cisd_events_associated_fvg_fk
      foreign key (associated_fvg_id) references ict_v2.pd_arrays(feature_id);
  end if;
end $$;

create table if not exists ict_v2.trading_setups (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null,
  model_version_id uuid not null,
  parameter_set_id uuid not null,
  algorithm_version text not null,
  exchange text not null,
  symbol text not null,
  execution_timeframe text not null,
  context_timeframe text not null,
  setup_model text not null default 'MODEL_1_SWEEP_REVERSAL',
  direction ict_v2.direction,
  mode ict_v2.entry_mode not null,
  state ict_v2.setup_state not null default 'SCANNING',
  decision ict_v2.trading_decision not null default 'WAIT',
  setup_score numeric(6, 3) not null default 0,
  hard_filter_passed boolean not null default false,
  missing_conditions jsonb not null default '[]'::jsonb,
  historical_stats jsonb,
  detected_at timestamptz not null,
  as_of_time timestamptz not null,
  state_changed_at timestamptz not null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trading_setups_model_algorithm_fk
    foreign key (model_version_id, algorithm_version)
    references ict_v2.model_versions(id, algorithm_version),
  constraint trading_setups_parameter_model_fk
    foreign key (parameter_set_id, model_version_id)
    references ict_v2.parameter_sets(id, model_version_id),
  constraint trading_setups_idempotency_nonempty check (btrim(idempotency_key) <> ''),
  constraint trading_setups_identity_nonempty check (
    btrim(exchange) <> '' and btrim(symbol) <> ''
    and btrim(execution_timeframe) <> '' and btrim(context_timeframe) <> ''
    and btrim(setup_model) <> ''
  ),
  constraint trading_setups_directional check (direction is null or direction in ('BULLISH', 'BEARISH')),
  constraint trading_setups_score_range check (setup_score between 0 and 100),
  constraint trading_setups_missing_array check (jsonb_typeof(missing_conditions) = 'array'),
  constraint trading_setups_stats_object check (
    historical_stats is null or jsonb_typeof(historical_stats) = 'object'
  ),
  constraint trading_setups_asof_safe check (
    detected_at <= as_of_time and state_changed_at <= as_of_time
  ),
  constraint trading_setups_expiry_order check (expires_at is null or expires_at >= detected_at),
  constraint trading_setups_idempotency_unique unique (idempotency_key)
);

create index if not exists trading_setups_live_lookup_idx
  on ict_v2.trading_setups
  (exchange, symbol, execution_timeframe, state, as_of_time desc);
create index if not exists trading_setups_version_lookup_idx
  on ict_v2.trading_setups (parameter_set_id, algorithm_version, as_of_time desc);

-- Append-only transition log. The application assigns a strictly increasing
-- transition_seq per setup and never rewrites a previous transition.
create table if not exists ict_v2.setup_state_history (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null,
  setup_id uuid not null references ict_v2.trading_setups(id),
  transition_seq integer not null,
  from_state ict_v2.setup_state,
  to_state ict_v2.setup_state not null,
  occurred_at timestamptz not null,
  as_of_time timestamptz not null,
  reason_code text,
  triggering_feature_id uuid references ict_v2.market_features(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint setup_state_history_key_nonempty check (btrim(idempotency_key) <> ''),
  constraint setup_state_history_seq_positive check (transition_seq > 0),
  constraint setup_state_history_actual_change check (from_state is null or from_state <> to_state),
  constraint setup_state_history_asof_safe check (occurred_at <= as_of_time),
  constraint setup_state_history_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint setup_state_history_seq_unique unique (setup_id, transition_seq),
  constraint setup_state_history_idempotency_unique unique (idempotency_key)
);

create index if not exists setup_state_history_time_idx
  on ict_v2.setup_state_history (setup_id, occurred_at, transition_seq);
create index if not exists setup_state_history_transition_idx
  on ict_v2.setup_state_history (from_state, to_state, occurred_at desc);

create table if not exists ict_v2.setup_feature_snapshots (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null,
  setup_id uuid not null references ict_v2.trading_setups(id),
  model_version_id uuid not null,
  parameter_set_id uuid not null,
  algorithm_version text not null,
  setup_state ict_v2.setup_state not null,
  as_of_time timestamptz not null,
  feature_ids uuid[] not null default '{}'::uuid[],
  feature_values jsonb not null default '{}'::jsonb,
  component_scores jsonb not null default '{}'::jsonb,
  setup_score numeric(6, 3) not null,
  created_at timestamptz not null default now(),
  constraint setup_snapshots_model_algorithm_fk
    foreign key (model_version_id, algorithm_version)
    references ict_v2.model_versions(id, algorithm_version),
  constraint setup_snapshots_parameter_model_fk
    foreign key (parameter_set_id, model_version_id)
    references ict_v2.parameter_sets(id, model_version_id),
  constraint setup_snapshots_key_nonempty check (btrim(idempotency_key) <> ''),
  constraint setup_snapshots_values_object check (jsonb_typeof(feature_values) = 'object'),
  constraint setup_snapshots_scores_object check (jsonb_typeof(component_scores) = 'object'),
  constraint setup_snapshots_score_range check (setup_score between 0 and 100),
  constraint setup_snapshots_idempotency_unique unique (idempotency_key),
  constraint setup_snapshots_asof_unique unique (setup_id, as_of_time, algorithm_version)
);

create index if not exists setup_feature_snapshots_training_idx
  on ict_v2.setup_feature_snapshots
  (parameter_set_id, setup_state, as_of_time desc);

create table if not exists ict_v2.trade_plans (
  id uuid primary key default gen_random_uuid(),
  setup_id uuid not null references ict_v2.trading_setups(id),
  plan_revision integer not null default 1,
  direction ict_v2.direction not null,
  entry_price_low numeric(28, 10) not null,
  entry_price_high numeric(28, 10) not null,
  stop_price numeric(28, 10) not null,
  entry_invalidation_price numeric(28, 10) not null,
  model_invalidation_price numeric(28, 10) not null,
  risk_distance numeric(28, 10) not null,
  risk_distance_atr numeric(18, 8) not null,
  minimum_rr numeric(12, 6) not null,
  valid_from timestamptz not null,
  valid_until timestamptz,
  created_at timestamptz not null default now(),
  constraint trade_plans_revision_positive check (plan_revision > 0),
  constraint trade_plans_directional check (direction in ('BULLISH', 'BEARISH')),
  constraint trade_plans_entry_range check (
    entry_price_low > 0 and entry_price_high >= entry_price_low
  ),
  constraint trade_plans_prices_positive check (
    stop_price > 0 and entry_invalidation_price > 0 and model_invalidation_price > 0
  ),
  constraint trade_plans_structural_side check (
    (
      direction = 'BULLISH'
      and stop_price < entry_price_low
      and entry_invalidation_price < entry_price_low
      and model_invalidation_price < entry_price_low
    )
    or
    (
      direction = 'BEARISH'
      and stop_price > entry_price_high
      and entry_invalidation_price > entry_price_high
      and model_invalidation_price > entry_price_high
    )
  ),
  constraint trade_plans_risk_positive check (risk_distance > 0 and risk_distance_atr > 0),
  constraint trade_plans_rr_floor check (minimum_rr >= 1.5),
  constraint trade_plans_validity_order check (valid_until is null or valid_until > valid_from),
  constraint trade_plans_revision_unique unique (setup_id, plan_revision)
);

create table if not exists ict_v2.trade_plan_targets (
  id uuid primary key default gen_random_uuid(),
  trade_plan_id uuid not null references ict_v2.trade_plans(id),
  target_order smallint not null,
  target_price numeric(28, 10) not null,
  target_rr numeric(12, 6) not null,
  liquidity_level_id uuid references ict_v2.liquidity_levels(feature_id),
  allocation_percent numeric(7, 4),
  rationale text,
  constraint trade_plan_targets_order_positive check (target_order > 0),
  constraint trade_plan_targets_price_positive check (target_price > 0),
  constraint trade_plan_targets_rr_positive check (target_rr > 0),
  constraint trade_plan_targets_allocation_range check (
    allocation_percent is null or allocation_percent between 0 and 100
  ),
  constraint trade_plan_targets_order_unique unique (trade_plan_id, target_order)
);

create table if not exists ict_v2.backtest_runs (
  id uuid primary key default gen_random_uuid(),
  run_key text not null,
  model_version_id uuid not null,
  parameter_set_id uuid not null,
  algorithm_version text not null,
  status ict_v2.run_status not null default 'QUEUED',
  dataset_name text not null,
  exchange text not null,
  symbol text not null,
  context_timeframe text not null,
  execution_timeframe text not null,
  sample_start timestamptz not null,
  sample_end timestamptz not null,
  out_of_sample_start timestamptz,
  execution_policy text not null default 'NEXT_CANDLE_CLOSE',
  intrabar_policy text not null,
  fee_rate numeric(12, 10) not null default 0,
  slippage_rate numeric(12, 10) not null default 0,
  config jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  constraint backtest_runs_model_algorithm_fk
    foreign key (model_version_id, algorithm_version)
    references ict_v2.model_versions(id, algorithm_version),
  constraint backtest_runs_parameter_model_fk
    foreign key (parameter_set_id, model_version_id)
    references ict_v2.parameter_sets(id, model_version_id),
  constraint backtest_runs_key_nonempty check (btrim(run_key) <> ''),
  constraint backtest_runs_identity_nonempty check (
    btrim(dataset_name) <> '' and btrim(exchange) <> '' and btrim(symbol) <> ''
    and btrim(context_timeframe) <> '' and btrim(execution_timeframe) <> ''
  ),
  constraint backtest_runs_sample_order check (sample_end > sample_start),
  constraint backtest_runs_oos_order check (
    out_of_sample_start is null
    or out_of_sample_start between sample_start and sample_end
  ),
  constraint backtest_runs_cost_range check (
    fee_rate between 0 and 1 and slippage_rate between 0 and 1
  ),
  constraint backtest_runs_config_object check (jsonb_typeof(config) = 'object'),
  constraint backtest_runs_runtime_order check (
    finished_at is null or started_at is null or finished_at >= started_at
  ),
  constraint backtest_runs_key_unique unique (run_key)
);

create index if not exists backtest_runs_version_status_idx
  on ict_v2.backtest_runs (parameter_set_id, status, created_at desc);

create table if not exists ict_v2.trades (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null,
  setup_id uuid references ict_v2.trading_setups(id),
  trade_plan_id uuid references ict_v2.trade_plans(id),
  backtest_run_id uuid references ict_v2.backtest_runs(id),
  model_version_id uuid not null,
  parameter_set_id uuid not null,
  algorithm_version text not null,
  environment ict_v2.execution_environment not null,
  status ict_v2.trade_status not null,
  mode ict_v2.entry_mode not null,
  exchange text not null,
  symbol text not null,
  timeframe text not null,
  direction ict_v2.direction not null,
  planned_entry numeric(28, 10),
  actual_entry numeric(28, 10),
  stop_price numeric(28, 10),
  actual_exit numeric(28, 10),
  quantity numeric(38, 12),
  risk_amount numeric(28, 10),
  opened_at timestamptz,
  closed_at timestamptz,
  result_r numeric(18, 8),
  mfe_r numeric(18, 8),
  mae_r numeric(18, 8),
  fees numeric(28, 10) not null default 0,
  slippage numeric(28, 10) not null default 0,
  exit_reason text,
  as_of_time timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint trades_model_algorithm_fk
    foreign key (model_version_id, algorithm_version)
    references ict_v2.model_versions(id, algorithm_version),
  constraint trades_parameter_model_fk
    foreign key (parameter_set_id, model_version_id)
    references ict_v2.parameter_sets(id, model_version_id),
  constraint trades_key_nonempty check (btrim(idempotency_key) <> ''),
  constraint trades_identity_nonempty check (
    btrim(exchange) <> '' and btrim(symbol) <> '' and btrim(timeframe) <> ''
  ),
  constraint trades_directional check (direction in ('BULLISH', 'BEARISH')),
  constraint trades_provenance check (
    setup_id is not null or backtest_run_id is not null
  ),
  constraint trades_backtest_environment check (
    (environment = 'BACKTEST' and backtest_run_id is not null)
    or (environment <> 'BACKTEST' and backtest_run_id is null)
  ),
  constraint trades_prices_positive check (
    (planned_entry is null or planned_entry > 0)
    and (actual_entry is null or actual_entry > 0)
    and (stop_price is null or stop_price > 0)
    and (actual_exit is null or actual_exit > 0)
  ),
  constraint trades_quantity_positive check (quantity is null or quantity > 0),
  constraint trades_risk_nonnegative check (risk_amount is null or risk_amount >= 0),
  constraint trades_cost_nonnegative check (fees >= 0 and slippage >= 0),
  constraint trades_lifecycle_order check (
    closed_at is null or opened_at is null or closed_at >= opened_at
  ),
  constraint trades_closed_result check (
    status <> 'CLOSED'
    or (
      closed_at is not null
      and actual_entry is not null
      and actual_exit is not null
      and result_r is not null
      and exit_reason is not null
    )
  ),
  constraint trades_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint trades_idempotency_unique unique (idempotency_key)
);

create index if not exists trades_live_performance_idx
  on ict_v2.trades
  (environment, model_version_id, parameter_set_id, closed_at desc)
  where status = 'CLOSED';
create index if not exists trades_backtest_run_idx
  on ict_v2.trades (backtest_run_id, closed_at)
  where environment = 'BACKTEST';

create table if not exists ict_v2.backtest_results (
  id uuid primary key default gen_random_uuid(),
  backtest_run_id uuid not null references ict_v2.backtest_runs(id),
  segment_key text not null default 'ALL',
  experiment_key text not null default 'BASE',
  mode ict_v2.entry_mode not null,
  sample_size integer not null,
  win_rate numeric(9, 8),
  average_r numeric(18, 8),
  median_r numeric(18, 8),
  average_win_r numeric(18, 8),
  average_loss_r numeric(18, 8),
  expectancy_r numeric(18, 8),
  profit_factor numeric(20, 8),
  maximum_drawdown_r numeric(20, 8),
  average_mfe_r numeric(18, 8),
  average_mae_r numeric(18, 8),
  total_fees numeric(28, 10) not null default 0,
  total_slippage numeric(28, 10) not null default 0,
  confidence text not null,
  metrics jsonb not null default '{}'::jsonb,
  calculated_at timestamptz not null default now(),
  constraint backtest_results_keys_nonempty check (
    btrim(segment_key) <> '' and btrim(experiment_key) <> ''
  ),
  constraint backtest_results_sample_nonnegative check (sample_size >= 0),
  constraint backtest_results_win_rate check (win_rate is null or win_rate between 0 and 1),
  constraint backtest_results_profit_factor check (profit_factor is null or profit_factor >= 0),
  constraint backtest_results_drawdown_nonnegative check (
    maximum_drawdown_r is null or maximum_drawdown_r >= 0
  ),
  constraint backtest_results_cost_nonnegative check (total_fees >= 0 and total_slippage >= 0),
  constraint backtest_results_confidence_valid check (
    confidence in ('INSUFFICIENT', 'PRELIMINARY', 'MODERATE', 'HIGHER_CONFIDENCE')
  ),
  constraint backtest_results_confidence_matches_sample check (
    (sample_size < 30 and confidence = 'INSUFFICIENT')
    or (sample_size between 30 and 99 and confidence = 'PRELIMINARY')
    or (sample_size between 100 and 299 and confidence = 'MODERATE')
    or (sample_size >= 300 and confidence = 'HIGHER_CONFIDENCE')
  ),
  constraint backtest_results_metrics_object check (jsonb_typeof(metrics) = 'object'),
  constraint backtest_results_natural_key unique
    (backtest_run_id, segment_key, experiment_key, mode)
);

create index if not exists backtest_results_expectancy_idx
  on ict_v2.backtest_results
  (experiment_key, expectancy_r desc, sample_size desc);

-- The schema is backend-only at launch. RLS is intentionally enabled without
-- client policies: table owners and Supabase service_role can perform writes,
-- while anon/authenticated PostgREST access remains deny-by-default.
alter table ict_v2.model_versions enable row level security;
alter table ict_v2.parameter_sets enable row level security;
alter table ict_v2.market_candles enable row level security;
alter table ict_v2.candle_indicators enable row level security;
alter table ict_v2.market_features enable row level security;
alter table ict_v2.swings enable row level security;
alter table ict_v2.liquidity_levels enable row level security;
alter table ict_v2.sweeps enable row level security;
alter table ict_v2.cisd_events enable row level security;
alter table ict_v2.displacements enable row level security;
alter table ict_v2.structure_events enable row level security;
alter table ict_v2.pd_arrays enable row level security;
alter table ict_v2.trading_setups enable row level security;
alter table ict_v2.setup_state_history enable row level security;
alter table ict_v2.setup_feature_snapshots enable row level security;
alter table ict_v2.trade_plans enable row level security;
alter table ict_v2.trade_plan_targets enable row level security;
alter table ict_v2.backtest_runs enable row level security;
alter table ict_v2.trades enable row level security;
alter table ict_v2.backtest_results enable row level security;

-- Supabase's backend service role is granted access only when that role exists.
-- RLS still blocks browser-facing anon/authenticated roles because no policies
-- are created for them. On vanilla PostgreSQL the application role should be
-- granted explicitly by the operator after this migration.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage on schema ict_v2 to service_role';
    execute 'grant select, insert, update, delete on all tables in schema ict_v2 to service_role';
  end if;
end $$;

commit;
