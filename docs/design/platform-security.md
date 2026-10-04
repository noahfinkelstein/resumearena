> **SUPERSEDED (2026-10-03).** This Supabase-based design is replaced by `platform-github.md` (GitHub-native: Pages + Actions + data branch + Anthropic API, no sign-in). It is kept only as a source of privacy and abuse-control ideas; nothing in it is to be implemented.

# ResumeArena — Platform, Data Model, Security, Privacy, Ops

Status: design v1 · Owner: Noah Finkelstein · Date: 2026-10-03
Scope: everything below the React SPA. Companion docs: `ranking.md` (rating math — owns the
formulas applied inside `apply_match_result`), `analysis-rubric.md` (what the analysis model
scores), `frontend.md` (SPA).

Fixed stack: Vite + React 19 SPA on GitHub Pages (`/resumearena/`), Supabase (Postgres 17, Auth,
Storage, Edge Functions on Deno, pg_cron, pg_net), Anthropic Claude via `npm:@anthropic-ai/sdk`.
Analysis model `claude-opus-5-5`; pairwise judge `claude-sonnet-5-5` (both configurable in
`settings`).

---

## 0. Architecture in one page

```
 Browser (GitHub Pages, anon key)                      Supabase project
 ─────────────────────────────────                     ──────────────────────────────────────────
 Auth (GitHub / Google / magic link) ───────────────▶  auth.users ──▶ public.profiles (trigger)
 RPC create_resume_draft() ─────────────────────────▶  resumes(status=uploaded)   [RLS + limits]
 Storage PUT resumes/{uid}/{resume_id}.pdf ─────────▶  storage.objects            [bucket policy]
 POST /functions/v1/analyze-resume {resume_id} ─────▶  verifies owner, hash, dedupe,
                                                       enqueue analysis_jobs, 202, waitUntil(work)
                                                        │  Claude opus (PDF → analysis JSON + card)
                                                        ▼
                                                       resumes(status=placing) + match_queue rows
 pg_cron */1 min ──pg_net──▶ POST run-matches  ──────▶  claims N queued matches (SKIP LOCKED),
   (Authorization: Bearer CRON_SECRET)                  Claude sonnet judge ×2 orderings,
                                                        apply_match_result() [SQL, owned by ranking.md]
                                                        usage_ledger += cost; stop at daily budget
 pg_cron */2 min ───────────────────────────────────▶  REFRESH MATERIALIZED VIEW leaderboard_mv
 GET leaderboard_public?category=eq.tech&rank=gt.50 ▶  PostgREST (anon select on view only)
 POST /functions/v1/arena {action: pair|vote} ──────▶  random public pair; vote → arena_votes →
                                                        apply_match_result(source='arena', low K)
 POST /functions/v1/delete-account ─────────────────▶  storage purge + auth.admin.deleteUser → cascade
```

Three principles that drive every decision below:

1. **Secrets never reach the browser.** The browser holds the anon key and a user JWT. Anything
   that touches `ANTHROPIC_API_KEY`, the service role, or ratings runs in an Edge Function or in
   `SECURITY DEFINER` SQL.
2. **The PDF is radioactive; the card is the product.** Only the owner and the analysis worker ever
   read the PDF. Everything public is derived from the anonymized `card`.
3. **Every expensive path is metered and has a kill switch** (`settings.paused`,
   `settings.daily_budget_cents`, per-user quotas, queue claims).

---

## 1. Postgres schema

All objects live in `public` unless noted. One migration file per section
(`supabase/migrations/2026100300xx_*.sql`). Conventions: `uuid` PKs via `gen_random_uuid()`,
`timestamptz` everywhere, `text` + `check` over `varchar(n)`, snake_case.

### 1.1 Extensions and enums

```sql
create extension if not exists pg_cron  with schema pg_catalog;
create extension if not exists pg_net   with schema extensions;
create extension if not exists pgcrypto with schema extensions;  -- digest() for hashes
create extension if not exists citext   with schema extensions;  -- case-insensitive handles

create type visibility      as enum ('public', 'anonymous');
create type resume_status   as enum ('uploaded', 'analyzing', 'placing', 'ranked', 'failed');
create type category        as enum ('general', 'finance', 'tech', 'academia');
create type career_stage    as enum ('student', 'new_grad', 'early', 'mid', 'senior', 'executive');
create type match_source    as enum ('judge', 'arena');
create type match_status    as enum ('queued', 'claimed', 'done', 'failed', 'skipped');
create type job_status      as enum ('queued', 'claimed', 'done', 'failed');
```

`visibility` semantics: `public` = handle + display name shown on the leaderboard; `anonymous` =
card is shown, identity fields are null. There is no "hidden" option in v1: uploading means
entering the arena. (A third `private` value is a one-line enum addition later.)

### 1.2 `profiles`

```sql
create table profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  handle         citext not null unique
                 check (handle ~ '^[a-z0-9][a-z0-9_]{2,23}$'),
  display_name   text not null check (char_length(display_name) between 1 and 60),
  visibility     visibility not null default 'anonymous',
  is_admin       boolean not null default false,          -- only settable via SQL editor
  terms_accepted_at timestamptz,                           -- null until the AI-analysis terms are accepted
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Reserved handles that should never be claimable.
create table reserved_handles (handle citext primary key);
insert into reserved_handles values ('admin'),('resumearena'),('arena'),('leaderboard'),
  ('settings'),('api'),('support'),('noah'),('me'),('null'),('undefined');

```

Postgres forbids subqueries in CHECK constraints, so the reserved-handle rule lives in the
trigger that creates the profile and in the update guard below:

```sql
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare base text; candidate text; n int := 0;
begin
  base := lower(regexp_replace(coalesce(new.raw_user_meta_data->>'user_name',
                                        new.raw_user_meta_data->>'preferred_username',
                                        split_part(new.email, '@', 1), 'user'),
                               '[^a-z0-9_]', '', 'g'));
  if char_length(base) < 3 then base := 'user' || base; end if;
  base := left(base, 20);
  candidate := base;
  while exists (select 1 from profiles where handle = candidate)
     or exists (select 1 from reserved_handles where handle = candidate) loop
    n := n + 1; candidate := base || n::text;
  end loop;
  insert into profiles (id, handle, display_name)
  values (new.id, candidate, coalesce(new.raw_user_meta_data->>'full_name', candidate));
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

create or replace function profiles_guard() returns trigger
language plpgsql as $$
begin
  if new.handle is distinct from old.handle
     and exists (select 1 from reserved_handles where handle = new.handle) then
    raise exception 'handle_reserved' using errcode = '23514';
  end if;
  -- clients may not escalate themselves
  if tg_op = 'UPDATE' and new.is_admin is distinct from old.is_admin
     and current_setting('request.jwt.claim.role', true) is distinct from 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger profiles_guard before update on profiles for each row execute function profiles_guard();
```

Anonymous auth users (used by the arena, §3.3) also get a profile row via this trigger; their
`handle` is `anon_<8 hex>` and `visibility` stays `anonymous`. They are purged after 30 days of
inactivity by a cron job.

### 1.3 `resumes`

```sql
create table resumes (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references profiles(id) on delete cascade,
  storage_path    text not null unique,                 -- '{owner_id}/{id}.pdf'
  file_hash       text,                                 -- sha256 hex; null until analyze step
  file_size       integer check (file_size between 1 and 5242880),
  status          resume_status not null default 'uploaded',
  failure_reason  text,                                 -- user-safe string, e.g. 'not_a_resume'
  career_stage    career_stage,                         -- model-inferred, user can override
  categories      category[] not null default '{general}'::category[]
                  check (cardinality(categories) between 1 and 4 and 'general' = any(categories)),
  analysis        jsonb,                                -- full structured output; OWNER ONLY
  card            jsonb,                                -- anonymized public card
  rubric_version  smallint,                             -- which prompt/rubric produced analysis
  analysis_model  text,
  superseded_by   uuid references resumes(id) on delete set null,
  duplicate_of    uuid references resumes(id) on delete set null,  -- same hash, different owner
  attempts        smallint not null default 0,
  created_at      timestamptz not null default now(),
  analyzed_at     timestamptz,
  ranked_at       timestamptz,
  updated_at      timestamptz not null default now()
);

-- Every resume is in 'general'; the other categories are opt-in and validated by the analysis step.
create index resumes_owner_idx         on resumes (owner_id, created_at desc);
create index resumes_status_idx        on resumes (status) where status in ('uploaded','analyzing');
create index resumes_hash_idx          on resumes (file_hash) where file_hash is not null;
create index resumes_active_idx        on resumes (owner_id) where superseded_by is null and status <> 'failed';
```

"One active resume per category" is enforced in `create_resume_draft` (§1.11), not by a unique
index, because supersession is a two-row transaction (new row inserted, old row pointed at it).

Status machine (only the worker and SQL functions transition; clients never update `status`):

```
uploaded ──analyze-resume accepted──▶ analyzing ──analysis ok──▶ placing ──placement matches done──▶ ranked
    │                                      │                                                             │
    └─ 1h without file → deleted           └─ error ×3 or not_a_resume → failed                  re-rank forever
```

### 1.4 `ratings` (per resume × category)

Column names are Glicko-2 shaped so `ranking.md` can be implemented without a schema change; if
the ranking doc picks plain Elo, `rd` and `vol` are simply left at their defaults.

```sql
create table ratings (
  resume_id      uuid not null references resumes(id) on delete cascade,
  category       category not null,
  rating         numeric(8,2) not null default 1500,
  rd             numeric(8,2) not null default 350,     -- rating deviation (uncertainty)
  vol            numeric(8,5) not null default 0.06,    -- volatility
  matches_played integer not null default 0,
  wins           integer not null default 0,
  losses         integer not null default 0,
  draws          integer not null default 0,
  provisional    boolean not null default true,         -- true until placement complete
  retired        boolean not null default false,        -- superseded resumes
  last_match_at  timestamptz,
  updated_at     timestamptz not null default now(),
  primary key (resume_id, category)
);

create index ratings_board_idx on ratings (category, rating desc, resume_id)
  where retired = false and provisional = false;
create index ratings_pool_idx  on ratings (category, rating) where retired = false;  -- opponent search
```

### 1.5 `matches`, `rating_history`

```sql
create table matches (
  id             uuid primary key default gen_random_uuid(),
  category       category not null,
  resume_a       uuid not null references resumes(id) on delete cascade,
  resume_b       uuid not null references resumes(id) on delete cascade,
  source         match_source not null,
  -- outcome from A's perspective: 1 = A wins, 0 = B wins, 0.5 = draw
  outcome        numeric(2,1) check (outcome in (0, 0.5, 1)),
  judge_model    text,
  judge_ab       jsonb,          -- {winner:'a'|'b'|'tie', confidence:0..1, reason:text}
  judge_ba       jsonb,          -- same prompt, cards swapped
  position_bias  boolean,        -- true when ab and ba disagree
  voter_id       uuid references profiles(id) on delete set null,  -- arena only
  rating_a_before numeric(8,2), rating_b_before numeric(8,2),
  rating_a_after  numeric(8,2), rating_b_after  numeric(8,2),
  input_tokens   integer, output_tokens integer, cost_cents numeric(8,4),
  created_at     timestamptz not null default now(),
  check (resume_a <> resume_b)
);
create index matches_a_idx on matches (resume_a, created_at desc);
create index matches_b_idx on matches (resume_b, created_at desc);
create index matches_cat_idx on matches (category, created_at desc);

create table rating_history (
  id             bigint generated always as identity primary key,
  resume_id      uuid not null references resumes(id) on delete cascade,
  category       category not null,
  match_id       uuid references matches(id) on delete set null,
  rating         numeric(8,2) not null,
  rd             numeric(8,2) not null,
  created_at     timestamptz not null default now()
);
create index rating_history_idx on rating_history (resume_id, category, created_at);
```

### 1.6 `match_queue`

```sql
create table match_queue (
  id             bigint generated always as identity primary key,
  category       category not null,
  resume_a       uuid not null references resumes(id) on delete cascade,
  resume_b       uuid not null references resumes(id) on delete cascade,
  reason         text not null check (reason in ('placement','refresh','rematch','manual')),
  priority       smallint not null default 100,          -- lower = sooner; placement = 10
  status         match_status not null default 'queued',
  claimed_at     timestamptz,
  claimed_by     text,                                   -- worker invocation id
  attempts       smallint not null default 0,
  last_error     text,
  created_at     timestamptz not null default now(),
  check (resume_a <> resume_b)
);
create index match_queue_claim_idx on match_queue (priority, id) where status = 'queued';
-- the same unordered pair is queued at most once at a time
create unique index match_queue_pair_uidx
  on match_queue (category, least(resume_a, resume_b), greatest(resume_a, resume_b))
  where status in ('queued','claimed');
```

Who enqueues: `enqueue_placement(resume_id)` (called by the analysis worker; picks
`settings.matches_per_placement` opponents per category spread across the rating distribution —
selection logic is in `ranking.md`) and a nightly `enqueue_refresh()` that gives every ranked resume
one or two matches against neighbours so the board keeps moving as new entrants arrive.

### 1.7 `analysis_jobs`

Not in the original list, but needed so `analyze-resume` can return in under a second and the
work survives a worker being killed at the wall-clock limit (§3.1).

```sql
create table analysis_jobs (
  id             bigint generated always as identity primary key,
  resume_id      uuid not null references resumes(id) on delete cascade,
  status         job_status not null default 'queued',
  attempts       smallint not null default 0,
  claimed_at     timestamptz,
  claimed_by     text,
  last_error     text,
  created_at     timestamptz not null default now()
);
create unique index analysis_jobs_active_uidx on analysis_jobs (resume_id) where status in ('queued','claimed');
create index analysis_jobs_claim_idx on analysis_jobs (id) where status = 'queued';
```

### 1.8 `arena_votes`, `arena_sessions`, `rate_limits`

```sql
create table arena_sessions (
  voter_id        uuid primary key references profiles(id) on delete cascade,
  votes_total     integer not null default 0,
  votes_counted   integer not null default 0,
  honeypot_fails  smallint not null default 0,
  trusted         boolean generated always as (votes_total >= 5 and honeypot_fails = 0) stored,
  first_seen      timestamptz not null default now(),
  last_seen       timestamptz not null default now()
);

create table arena_votes (
  id             bigint generated always as identity primary key,
  pair_token     text not null unique,            -- HMAC issued with the pair; idempotency key
  voter_id       uuid not null references profiles(id) on delete cascade,
  category       category not null,
  resume_a       uuid references resumes(id) on delete set null,
  resume_b       uuid references resumes(id) on delete set null,
  choice         text not null check (choice in ('a','b','tie','skip')),
  is_honeypot    boolean not null default false,
  counted        boolean not null default false,  -- applied to ratings?
  match_id       uuid references matches(id) on delete set null,
  decided_ms     integer,                          -- time between pair served and vote
  created_at     timestamptz not null default now()
);
create index arena_votes_voter_idx on arena_votes (voter_id, created_at desc);

create table rate_limits (
  bucket        text not null,            -- 'arena_pair', 'arena_vote', 'analyze', ...
  key           text not null,            -- uid or ip hash
  window_start  timestamptz not null,
  count         integer not null default 0,
  primary key (bucket, key, window_start)
);

create or replace function check_rate_limit(p_bucket text, p_key text, p_limit int, p_window interval)
returns boolean language plpgsql security definer set search_path = public as $$
declare ws timestamptz := date_trunc('minute', now()) - (extract(minute from now())::int % greatest(1, extract(epoch from p_window)::int / 60)) * interval '1 minute';
        c int;
begin
  insert into rate_limits (bucket, key, window_start, count) values (p_bucket, p_key, ws, 1)
  on conflict (bucket, key, window_start) do update set count = rate_limits.count + 1
  returning count into c;
  return c <= p_limit;
end $$;
-- cron: delete from rate_limits where window_start < now() - interval '1 day';
```

### 1.9 `usage_ledger`, `settings`

```sql
create table usage_ledger (
  day               date not null,
  function_name     text not null,        -- 'analyze-resume' | 'run-matches' | 'arena'
  model             text not null,        -- '' for non-LLM rows
  calls             integer not null default 0,
  errors            integer not null default 0,
  input_tokens      bigint not null default 0,
  output_tokens     bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  cost_cents        numeric(12,4) not null default 0,
  primary key (day, function_name, model)
);

create or replace function record_usage(p_fn text, p_model text, p_in bigint, p_out bigint,
                                        p_cache bigint, p_cost numeric, p_error boolean default false)
returns void language sql security definer set search_path = public as $$
  insert into usage_ledger as u (day, function_name, model, calls, errors, input_tokens, output_tokens, cache_read_tokens, cost_cents)
  values (current_date, p_fn, p_model, 1, (p_error)::int, p_in, p_out, p_cache, p_cost)
  on conflict (day, function_name, model) do update set
    calls = u.calls + 1, errors = u.errors + excluded.errors,
    input_tokens = u.input_tokens + excluded.input_tokens,
    output_tokens = u.output_tokens + excluded.output_tokens,
    cache_read_tokens = u.cache_read_tokens + excluded.cache_read_tokens,
    cost_cents = u.cost_cents + excluded.cost_cents;
$$;

create table settings (
  id                     smallint primary key default 1 check (id = 1),
  daily_budget_cents     integer not null default 1500,          -- $15/day hard cap on LLM spend
  judge_model            text not null default 'claude-sonnet-5-5',
  analysis_model         text not null default 'claude-opus-5-5',
  matches_per_placement  smallint not null default 12,
  matches_per_tick       smallint not null default 20,           -- run-matches batch size
  judge_concurrency      smallint not null default 4,
  analyses_per_user_day  smallint not null default 3,
  paused                 boolean not null default false,          -- global kill switch
  arena_paused           boolean not null default false,
  rubric_version         smallint not null default 1,
  updated_at             timestamptz not null default now()
);
insert into settings default values;

create or replace function budget_remaining_cents() returns numeric
language sql stable security definer set search_path = public as $$
  select s.daily_budget_cents - coalesce((select sum(cost_cents) from usage_ledger where day = current_date), 0)
  from settings s where s.id = 1;
$$;
```

Price table used for `cost_cents` (hard-coded in a shared Deno module, bumped by hand):
opus-5-5 $4/$20 per MTok, cache read $0.20; sonnet-5-5 $2/$10, cache read $0.20; haiku-4-5
$1/$5. Back-of-envelope: one analysis (2-page PDF ≈ 5k input incl. page images + 2.5k output) ≈
3¢–7¢; one judged match (two orderings × ~1.8k in / 150 out on sonnet) ≈ 1¢. A default placement of
12 matches ≈ 12¢, so a new resume costs ~20¢ all-in; $15/day ≈ 75 new resumes/day plus refresh
traffic. The judge is the lever: switching `judge_model` to `claude-haiku-4-5` halves match cost.

### 1.10 Leaderboard: materialized view + public view, keyset pagination

Ranks are computed by a materialized view refreshed every 2 minutes. Ratings update per match in
real time (the owner sees that on their own page); the public board moving every two minutes is
"continuous" from the reader's point of view and keeps the hot path a single index scan.

```sql
create materialized view leaderboard_mv as
select
  r.category,
  row_number() over (partition by r.category order by r.rating desc, r.resume_id) as rank,
  r.resume_id,
  r.rating::int                                    as rating,
  r.rd::int                                        as rd,
  r.matches_played,
  s.career_stage,
  s.card,                                          -- anonymized card only
  case when p.visibility = 'public' then p.handle       end as handle,
  case when p.visibility = 'public' then p.display_name end as display_name,
  s.ranked_at
from ratings r
join resumes  s on s.id = r.resume_id
join profiles p on p.id = s.owner_id
where r.retired = false and r.provisional = false
  and s.status = 'ranked' and s.superseded_by is null;

create unique index leaderboard_mv_pk   on leaderboard_mv (category, rank);
create unique index leaderboard_mv_res  on leaderboard_mv (category, resume_id);
create index        leaderboard_mv_stage on leaderboard_mv (category, career_stage, rank);

create view leaderboard_public with (security_invoker = false) as
  select category, rank, resume_id, rating, rd, matches_played, career_stage, card,
         handle, display_name, ranked_at
  from leaderboard_mv;

revoke all on leaderboard_mv from anon, authenticated;
grant select on leaderboard_public to anon, authenticated;

-- refreshed by cron; CONCURRENTLY needs the unique index above
select cron.schedule('refresh-leaderboard', '*/2 * * * *',
  $$refresh materialized view concurrently public.leaderboard_mv$$);
```

The view deliberately exposes **no** `owner_id`, no `analysis`, no `storage_path`, no
`file_hash`. `resume_id` is exposed (it is a random uuid) so the client can deep-link a card.

Keyset pagination from the client (PostgREST):

```
GET /rest/v1/leaderboard_public?category=eq.tech&rank=gt.100&order=rank.asc&limit=50
GET /rest/v1/leaderboard_public?category=eq.tech&career_stage=eq.student&rank=gt.0&order=rank.asc&limit=50
```

`rank` is dense within a category and unique, so `rank > last_seen_rank` is a correct, index-backed
cursor with no OFFSET. "Where am I?" is a point lookup on `(category, resume_id)`. Total count per
category is cached in a tiny `leaderboard_stats` table written by the same cron job (so the UI
never asks PostgREST for `count=exact` over 100k rows).

```sql
create table leaderboard_stats (category category primary key, total integer not null, refreshed_at timestamptz not null);
grant select on leaderboard_stats to anon, authenticated;
```

### 1.11 RPCs callable by clients

```sql
-- Creates the resume row and returns the storage path to upload to.
create or replace function create_resume_draft(p_categories category[], p_stage career_stage default null)
returns table (resume_id uuid, storage_path text)
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); rid uuid; used int; st settings;
begin
  if uid is null then raise exception 'unauthenticated' using errcode = '28000'; end if;
  select * into st from settings where id = 1;
  if st.paused then raise exception 'paused' using errcode = 'P0001'; end if;
  if not exists (select 1 from profiles where id = uid and terms_accepted_at is not null) then
    raise exception 'terms_not_accepted' using errcode = 'P0001';
  end if;
  if (select coalesce((auth.jwt()->>'is_anonymous')::boolean, false)) then
    raise exception 'anonymous_cannot_upload' using errcode = '42501';
  end if;
  -- per-user daily quota counts drafts created today (so abandoned uploads also burn quota)
  select count(*) into used from resumes where owner_id = uid and created_at > now() - interval '24 hours';
  if used >= st.analyses_per_user_day then raise exception 'daily_limit' using errcode = 'P0001'; end if;
  -- garbage-collect this user's un-uploaded drafts
  delete from resumes where owner_id = uid and status = 'uploaded' and created_at < now() - interval '1 hour';

  rid := gen_random_uuid();
  insert into resumes (id, owner_id, storage_path, categories, career_stage)
  values (rid, uid, uid::text || '/' || rid::text || '.pdf',
          (select array_agg(distinct c) from unnest(p_categories || '{general}'::category[]) c), p_stage);
  return query select rid, uid::text || '/' || rid::text || '.pdf';
end $$;
revoke all on function create_resume_draft(category[], career_stage) from public;
grant execute on function create_resume_draft(category[], career_stage) to authenticated;

-- Profile edits are plain UPDATEs under RLS (handle, display_name, visibility, terms_accepted_at).
-- Supersession is done by the worker, not the client: when a new resume for a user reaches
-- 'placing', supersede_previous(new_id) marks the older active resume superseded_by = new_id,
-- sets its ratings.retired = true and seeds the new ratings from the old (see ranking.md).
```

### 1.12 Indexes summary (hot paths → index)

| Query | Index |
|---|---|
| leaderboard page | `leaderboard_mv_pk (category, rank)` |
| my rank | `leaderboard_mv_res (category, resume_id)` |
| worker claim | `match_queue_claim_idx`, `analysis_jobs_claim_idx` (partial, tiny) |
| opponent search by rating band | `ratings_pool_idx (category, rating)` |
| my resumes | `resumes_owner_idx` |
| dedupe | `resumes_hash_idx` |
| arena pair sampling | `ratings_pool_idx` + random anchor (§3.3) |
| budget check | `usage_ledger` PK (one day's rows ≈ 6) |

---

## 2. Row-level security and Storage

RLS is enabled on every table. Default is deny; policies below are the whole allow-list. The
service role (used only inside Edge Functions and cron SQL) bypasses RLS.

```sql
alter table profiles        enable row level security;
alter table resumes         enable row level security;
alter table ratings         enable row level security;
alter table matches         enable row level security;
alter table rating_history  enable row level security;
alter table match_queue     enable row level security;
alter table analysis_jobs   enable row level security;
alter table arena_votes     enable row level security;
alter table arena_sessions  enable row level security;
alter table rate_limits     enable row level security;
alter table usage_ledger    enable row level security;
alter table settings        enable row level security;
alter table reserved_handles enable row level security;
alter table leaderboard_stats enable row level security;
```

### 2.1 Policies

```sql
-- profiles: anyone can read public identity columns of public profiles (via a view);
-- owners read/update their own row; nobody inserts/deletes from the client (trigger + cascade).
create policy profiles_select_own   on profiles for select to authenticated using (id = auth.uid());
create policy profiles_update_own   on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create view profiles_public with (security_invoker = false) as
  select id, handle, display_name, created_at from profiles where visibility = 'public';
grant select on profiles_public to anon, authenticated;

-- resumes: owner reads full row; no direct insert (RPC only); owner may update categories and
-- career_stage only; owner may delete.
create policy resumes_select_own on resumes for select to authenticated using (owner_id = auth.uid());
create policy resumes_delete_own on resumes for delete to authenticated using (owner_id = auth.uid());
create policy resumes_update_own on resumes for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
-- column-level: clients can only touch these two columns
revoke update on resumes from authenticated;
grant  update (categories, career_stage) on resumes to authenticated;
revoke insert on resumes from anon, authenticated;

-- public card read for deep links / arena / profile pages: a view, not a policy, so the
-- column allow-list is explicit.
create view resume_cards_public with (security_invoker = false) as
  select s.id as resume_id, s.card, s.career_stage, s.categories, s.ranked_at,
         case when p.visibility = 'public' then p.handle end as handle
  from resumes s join profiles p on p.id = s.owner_id
  where s.status in ('placing','ranked') and s.superseded_by is null and s.card is not null;
grant select on resume_cards_public to anon, authenticated;

-- ratings / matches / rating_history: owner reads rows about own resumes; NO client writes at all.
create policy ratings_select_own on ratings for select to authenticated
  using (exists (select 1 from resumes r where r.id = ratings.resume_id and r.owner_id = auth.uid()));
create policy matches_select_own on matches for select to authenticated
  using (exists (select 1 from resumes r where r.id in (matches.resume_a, matches.resume_b) and r.owner_id = auth.uid()));
create policy history_select_own on rating_history for select to authenticated
  using (exists (select 1 from resumes r where r.id = rating_history.resume_id and r.owner_id = auth.uid()));
revoke insert, update, delete on ratings, matches, rating_history from anon, authenticated;

-- A match row shows the opponent's resume_id; the opponent's identity is only resolvable through
-- resume_cards_public, which already respects visibility. The owner-facing match list therefore
-- shows "vs. an anonymous senior engineer" when the opponent is anonymous.

-- match_queue, analysis_jobs, rate_limits, usage_ledger, settings, arena_sessions: no client policies
-- (service role only). The client reads a safe projection of settings:
create view settings_public with (security_invoker = false) as
  select paused, arena_paused, analyses_per_user_day, rubric_version from settings;
grant select on settings_public to anon, authenticated;

-- arena_votes: voter can read own votes (for a "your record" screen); inserts only via function.
create policy votes_select_own on arena_votes for select to authenticated using (voter_id = auth.uid());
revoke insert, update, delete on arena_votes from anon, authenticated;

grant select on leaderboard_stats to anon, authenticated;  -- no RLS policy needed for a definer view,
-- but the base table has RLS on with a permissive read policy:
create policy stats_read on leaderboard_stats for select to anon, authenticated using (true);
```

Why views with `security_invoker = false` for public data instead of permissive policies on base
tables: a policy grants access to *rows*, but PostgREST then lets the caller `select=*`. The
anonymized surface must be a column allow-list, and a definer view is the only construct that
expresses that directly. Base tables keep owner-only policies, so a bug in a view can at worst
over-expose what the view selects — which is already the anonymized card.

### 2.2 Storage bucket `resumes`

```sql
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('resumes', 'resumes', false, 5242880, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 5242880,
                               allowed_mime_types = array['application/pdf'];

-- Path contract: {auth.uid()}/{resume_id}.pdf, and the resume row must already exist and be the
-- caller's, in status 'uploaded'. This makes the storage object a child of the DB row.
create policy resumes_upload on storage.objects for insert to authenticated
with check (
  bucket_id = 'resumes'
  and (storage.foldername(name))[1] = auth.uid()::text
  and name ~ ('^' || auth.uid()::text || '/[0-9a-f-]{36}\.pdf$')
  and exists (select 1 from public.resumes r
              where r.storage_path = name and r.owner_id = auth.uid() and r.status = 'uploaded')
);
create policy resumes_read_own   on storage.objects for select to authenticated
  using (bucket_id = 'resumes' and (storage.foldername(name))[1] = auth.uid()::text);
create policy resumes_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'resumes' and (storage.foldername(name))[1] = auth.uid()::text);
-- no UPDATE policy: a PDF is immutable once uploaded; re-uploading means a new resume row.
```

Client upload: `supabase.storage.from('resumes').upload(path, file, { contentType: 'application/pdf',
upsert: false })` with the user's session. Bucket-level `file_size_limit` and `allowed_mime_types`
are enforced server-side regardless of what the client claims; the client additionally checks
`file.size <= 5 MB` and the `%PDF-` magic bytes before uploading so the error is instant.

**PDF-only in v1.** Copy shown in the UI: *"PDF only for now (5 MB max). Export from Word or
Google Docs with File → Download → PDF."* DOCX is deferred because (a) Claude reads PDFs natively
as page images + text, so layout, whitespace and typographic signals — part of how ATS systems
and humans actually see a resume — survive; a DOCX would need a server-side render to PDF
(LibreOffice is not available in Deno/Edge, and a third-party conversion API adds a vendor,
latency and a second place PII travels), and (b) ~95% of resumes already ship as PDF. DOCX→PDF
conversion becomes a v2 Edge Function only if upload-abandonment data says it matters.

---

## 3. Edge Functions (Deno)

Layout:

```
supabase/functions/
  _shared/
    cors.ts          # allow-list + preflight helper
    auth.ts          # requireUser(req) / requireCron(req)
    anthropic.ts     # client factory, withRetry(), priceCents()
    pii.ts           # regex scrub pass
    schemas.ts       # zod schemas for analysis + judge output
    db.ts            # service-role client
  analyze-resume/index.ts
  run-matches/index.ts
  arena/index.ts
  delete-account/index.ts
  import_map.json / deno.json
```

Runtime limits (supabase.com/docs/guides/functions/limits, verified 2026-10-03): wall-clock
**150 s (Free) / 400 s (Pro)**, **2 s CPU time per request** (async I/O excluded), **256 MB
memory**. `EdgeRuntime.waitUntil(promise)` keeps the instance alive after the response until the
promise settles, still bounded by the same limits. Consequences:

- An Opus analysis of a PDF typically takes 20–90 s of *waiting*, which is fine (I/O), but we
  must never block the HTTP response on it — the browser's fetch would also time out.
- CPU budget is tight: base64-encoding a 5 MB PDF is ~10 ms; JSON parsing is trivial; never do
  PDF parsing or image work in the function. All heavy lifting is in the model.
- Worker invocations are designed so that *being killed is safe*: every unit of work is claimed
  in the DB with a lease, and a sweeper requeues expired leases.

### 3.1 Shared helpers

```ts
// _shared/cors.ts
const ALLOWED = new Set([
  "https://noahfinkelstein.github.io",   // GitHub Pages origin (path is not part of an origin)
  "http://localhost:5173",
]);
export function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get("origin") ?? "";
  const allow = ALLOWED.has(origin) ? origin : "https://noahfinkelstein.github.io";
  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, idempotency-key",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}
export const preflight = (req: Request) =>
  req.method === "OPTIONS" ? new Response(null, { status: 204, headers: corsHeaders(req) }) : null;
```

```ts
// _shared/auth.ts
import { createClient } from "npm:@supabase/supabase-js@2";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export const admin = () => createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

/** Verifies the caller's JWT by asking Auth, returns the user + a client scoped to that user (RLS on). */
export async function requireUser(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) throw new HttpError(401, "missing_token");
  const asUser = createClient(SUPABASE_URL, ANON, {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  });
  const { data, error } = await asUser.auth.getUser();        // validates signature + expiry server-side
  if (error || !data.user) throw new HttpError(401, "invalid_token");
  return { user: data.user, asUser, isAnonymous: data.user.is_anonymous === true };
}

/** Cron / internal calls: constant-time compare against CRON_SECRET. */
export function requireCron(req: Request) {
  const given = (req.headers.get("authorization") ?? "").replace("Bearer ", "");
  const want = Deno.env.get("CRON_SECRET") ?? "";
  if (!want || !timingSafeEqual(given, want)) throw new HttpError(401, "forbidden");
}
```

`config.toml` sets `verify_jwt = false` for all four functions: the gateway check would reject
the cron call (which carries `CRON_SECRET`, not a JWT) and `getUser()` is the stronger check anyway
(it catches revoked sessions and banned users; a gateway-only check does not).

```ts
// _shared/anthropic.ts
import Anthropic from "npm:@anthropic-ai/sdk";
export const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")!, maxRetries: 0, timeout: 120_000 });

const PRICE: Record<string, { in: number; out: number; cache: number }> = {   // $ per MTok
  "claude-opus-5-5":   { in: 4, out: 20, cache: 0.20 },
  "claude-sonnet-5-5": { in: 2, out: 10, cache: 0.20 },
  "claude-haiku-4-5":  { in: 1, out: 5,  cache: 0.10 },
};
export function priceCents(model: string, u: Anthropic.Usage) {
  const p = PRICE[model] ?? PRICE["claude-opus-5-5"];
  const nonCached = u.input_tokens - (u.cache_read_input_tokens ?? 0);
  return (nonCached * p.in + (u.cache_read_input_tokens ?? 0) * p.cache + u.output_tokens * p.out) / 1e6 * 100;
}

/** Retry only what is retryable, with jittered exponential backoff and a wall-clock ceiling. */
export async function withRetry<T>(fn: () => Promise<T>, { tries = 4, baseMs = 1500, deadlineMs = 90_000 } = {}): Promise<T> {
  const start = Date.now();
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (err) {
      const retryable =
        err instanceof Anthropic.RateLimitError ||                     // 429
        err instanceof Anthropic.InternalServerError ||                // 5xx incl. 529 overloaded
        err instanceof Anthropic.APIConnectionError ||                 // network / timeout
        (err instanceof Anthropic.APIError && err.status === 529);
      if (!retryable || i + 1 >= tries || Date.now() - start > deadlineMs) throw err;
      const retryAfter = err instanceof Anthropic.APIError ? Number(err.headers?.["retry-after"]) : NaN;
      const wait = Number.isFinite(retryAfter) ? retryAfter * 1000
                 : baseMs * 2 ** i * (0.5 + Math.random());
      await new Promise(r => setTimeout(r, Math.min(wait, 20_000)));
    }
  }
}
```

Error classification (most specific first) is used everywhere a model is called:
`Anthropic.BadRequestError` (400 — our bug or a PDF the API rejects: mark job failed, do not retry),
`Anthropic.AuthenticationError`/`PermissionDeniedError` (401/403 — page the owner, pause),
`Anthropic.RateLimitError` (429 — retry, then leave job queued), `Anthropic.InternalServerError`
(500/529 — retry), `Anthropic.APIConnectionError` (retry), then `Anthropic.APIError`.
`stop_reason === "refusal"` and `stop_reason === "max_tokens"` are checked before reading
`parsed_output`; a refusal marks the resume `failed` with `failure_reason = 'declined'`.

### 3.2 `analyze-resume`

Request: `POST /functions/v1/analyze-resume` `{ "resume_id": uuid }` with the user's JWT.
Response: `202 { status: "analyzing" }` within ~500 ms, or `200 { status: "ranked" | "placing" }` when
the hash matched an earlier analysis by the same user. The client then subscribes to its own
`resumes` row via Realtime (owner RLS applies) or polls every 3 s.

Idempotency: `resume_id` *is* the idempotency key — one `analysis_jobs` row can be active per
resume (unique partial index), and a second POST while a job is active returns 202 again with no
side effects.

```ts
Deno.serve(async (req) => {
  const pre = preflight(req); if (pre) return pre;
  try {
    const { user, isAnonymous } = await requireUser(req);
    if (isAnonymous) throw new HttpError(403, "sign_in_required");
    const { resume_id } = await req.json();
    const db = admin();

    const { data: s } = await db.from("settings").select("paused").single();
    if (s?.paused) throw new HttpError(503, "paused");

    const { data: r } = await db.from("resumes").select("*").eq("id", resume_id).eq("owner_id", user.id).single();
    if (!r) throw new HttpError(404, "not_found");
    if (r.status !== "uploaded" && r.status !== "failed") return json(202, { status: r.status });

    // object must exist and be within limits (bucket enforces too; this gives a clean error)
    const { data: obj } = await db.schema("storage").from("objects").select("metadata")
      .eq("bucket_id", "resumes").eq("name", r.storage_path).single();
    if (!obj) throw new HttpError(409, "file_missing");
    const size = Number(obj.metadata?.size ?? 0);
    if (size === 0 || size > 5_242_880) throw new HttpError(413, "file_too_large");

    // enqueue (no-op if already active) and transition
    const { data: job } = await db.from("analysis_jobs").insert({ resume_id }).select().maybeSingle();
    await db.from("resumes").update({ status: "analyzing", failure_reason: null, file_size: size }).eq("id", resume_id);

    // Fast path: process this job in the background of this very invocation.
    if (job) EdgeRuntime.waitUntil(processAnalysisJob(job.id, crypto.randomUUID()));
    return json(202, { status: "analyzing" });
  } catch (e) { return errorResponse(req, e); }
});
```

`processAnalysisJob(jobId, workerId)` is the same function the cron sweeper runs
(`POST /analyze-resume` with `CRON_SECRET` and `{ sweep: true }` every minute claims up to 3 queued
jobs plus any `claimed` jobs older than 5 minutes — i.e. jobs whose worker was killed). Steps:

```
1. UPDATE analysis_jobs SET status='claimed', claimed_at=now(), claimed_by=$worker, attempts=attempts+1
     WHERE id=$job AND (status='queued' OR (status='claimed' AND claimed_at < now()-'5 min'))
   → 0 rows: someone else has it; return.
   → attempts > 3: mark job failed, resume failed ('analysis_failed'); return.
2. Download PDF with service role: storage.from('resumes').download(path) → ArrayBuffer.
   sha256 → file_hash.
   a. Same owner has a non-failed resume with this hash and the current rubric_version →
      copy analysis/card/career_stage, status := that resume's status (or 'placing'),
      mark job done, return. (Free re-upload of the same file.)
   b. Other owner has this hash → set duplicate_of; if ≥3 distinct owners already share
      this hash → fail with 'duplicate_file' (mass-upload of one PDF). Else continue.
3. Call the analysis model (below). Validate with zod; run PII regex post-pass on the card.
4. If analysis.is_resume === false → resume failed ('not_a_resume'); job done; record_usage; return.
5. Single transaction (RPC finalize_analysis(resume_id, analysis, card, stage, categories, model, rubric, usage)):
     resumes ← analysis, card, career_stage, categories (model-validated subset of requested ∪ general),
               status='placing', analyzed_at, rubric_version, analysis_model
     supersede_previous(resume_id)             -- retire the older active resume, carry rating prior
     ratings ← one row per category (defaults or carried prior)
     enqueue_placement(resume_id)              -- settings.matches_per_placement per category, priority 10
     analysis_jobs ← done
     record_usage('analyze-resume', model, in, out, cache, cents)
6. On any Anthropic error after retries: job back to 'queued' with last_error (so the sweeper
   picks it up next minute); resume stays 'analyzing'. Client copy: "Still analyzing — this
   usually takes under two minutes."
```

The model call:

```ts
const msg = await withRetry(() => anthropic.messages.parse({
  model: settings.analysis_model,                        // claude-opus-5-5
  max_tokens: 8000,
  thinking: { type: "adaptive" },
  output_config: { effort: "medium", format: zodOutputFormat(AnalysisSchema) },
  system: [{ type: "text", text: ANALYSIS_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
  messages: [{
    role: "user",
    content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
      { type: "text", text: `Requested categories: ${r.categories.join(", ")}. Rubric version ${settings.rubric_version}.` },
    ],
  }],
}), { deadlineMs: 110_000 });
if (msg.stop_reason === "refusal") throw new Declined();
if (msg.stop_reason === "max_tokens" || !msg.parsed_output) throw new Anthropic.BadRequestError(/*…*/);
```

The system prompt is identical across calls (rubric text + prestige tables + output rules) and
is ~6k tokens, so it is cached after the first call of each 5-minute window; the PDF comes after
the breakpoint. `effort: "medium"` is set explicitly (Opus 5.5 defaults to medium; written down so
a later bump is a deliberate change).

Output schema (JSON Schema rendered from zod; `additionalProperties: false` everywhere):

```json
{
  "type": "object", "required": ["is_resume","career_stage","categories","card","scores","analysis"],
  "properties": {
    "is_resume": { "type": "boolean" },
    "not_resume_reason": { "type": ["string","null"] },
    "career_stage": { "enum": ["student","new_grad","early","mid","senior","executive"] },
    "categories": { "type": "array", "items": { "enum": ["general","finance","tech","academia"] },
                    "description": "Subset of requested categories this resume plausibly competes in; always includes general." },
    "card": {
      "type": "object", "required": ["headline","education","experience","highlights","skills","signals"],
      "description": "ANONYMIZED. No name, email, phone, address, URL, handle, photo description, or employer-internal identifiers.",
      "properties": {
        "headline":   { "type": "string", "maxLength": 90, "description": "e.g. 'CS student, Brown; SWE intern at a top-tier infra company'" },
        "education":  { "type": "array", "items": { "type": "object", "required": ["institution","degree","field","year","honors"],
                        "properties": { "institution": {"type":"string"}, "degree": {"type":"string"}, "field": {"type":"string"},
                                        "year": {"type":["integer","null"]}, "honors": {"type":"array","items":{"type":"string"}} } } },
        "experience": { "type": "array", "items": { "type": "object", "required": ["org","title","kind","months","bullets"],
                        "properties": { "org": {"type":"string"}, "title": {"type":"string"},
                                        "kind": {"enum":["fulltime","internship","research","founder","parttime","other"]},
                                        "months": {"type":["integer","null"]},
                                        "bullets": {"type":"array","maxItems":3,"items":{"type":"string","maxLength":160}} } } },
        "highlights": { "type": "array", "maxItems": 6, "items": {"type":"string","maxLength":140},
                        "description": "Awards, publications, competitions, shipped products, scale numbers." },
        "skills":     { "type": "array", "maxItems": 15, "items": {"type":"string"} },
        "signals":    { "type": "array", "maxItems": 8, "items": {"type":"string"},
                        "description": "Short prestige/impact tags: 'FAANG internship', 'first-author publication', 'YC-backed', 'IMO medalist'." }
      }
    },
    "scores": {
      "type": "object", "required": ["overall","pedigree","impact","trajectory","clarity","ats"],
      "properties": { "overall": {"type":"number","minimum":0,"maximum":100}, "pedigree": {"type":"number","minimum":0,"maximum":100},
                      "impact": {"type":"number","minimum":0,"maximum":100}, "trajectory": {"type":"number","minimum":0,"maximum":100},
                      "clarity": {"type":"number","minimum":0,"maximum":100}, "ats": {"type":"number","minimum":0,"maximum":100} },
      "description": "Rubric scores used as the rating prior (ranking.md) and shown only to the owner."
    },
    "analysis": {
      "type": "object", "required": ["summary","strengths","weaknesses","ats_notes","suggestions","prestige_assessment"],
      "properties": { "summary": {"type":"string"}, "strengths": {"type":"array","items":{"type":"string"}},
                      "weaknesses": {"type":"array","items":{"type":"string"}},
                      "ats_notes": {"type":"array","items":{"type":"string"},"description":"How an ATS/keyword screener would parse this: missing dates, tables, columns, images-as-text, missing keywords."},
                      "suggestions": {"type":"array","items":{"type":"string"}},
                      "prestige_assessment": {"type":"string"} },
      "description": "Owner-only feedback. May reference the candidate in second person; must still not repeat contact details."
    },
    "pii_detected": { "type": "array", "items": { "enum": ["name","email","phone","address","url","photo","dob","other"] } }
  }
}
```

### 3.3 `run-matches`

Invoked by pg_cron every minute via pg_net (§6.4) with `Authorization: Bearer <CRON_SECRET>`.
Also invocable manually by an admin for backfills with `{ "max": 200 }`.

```
1. requireCron(req). Read settings; if paused → 200 {skipped:'paused'}.
2. budget := budget_remaining_cents(); if budget < 5 → 200 {skipped:'budget'} (leave queue intact).
3. Claim a batch (single statement, safe under concurrent invocations):
     WITH c AS (
       SELECT id FROM match_queue WHERE status='queued'
       ORDER BY priority, id LIMIT $matches_per_tick FOR UPDATE SKIP LOCKED)
     UPDATE match_queue q SET status='claimed', claimed_at=now(), claimed_by=$worker, attempts=attempts+1
     FROM c WHERE q.id=c.id RETURNING q.*;
   Also requeue leases older than 10 minutes (killed workers) — one UPDATE before the claim.
4. Load both cards for each claimed row (resumes.card, must still be status in (placing,ranked)
   and superseded_by is null; otherwise mark 'skipped').
5. Judge with a concurrency cap (settings.judge_concurrency, default 4 → ≤8 in-flight model
   calls since each match is two orderings). Each match:
     [ab, ba] = await Promise.all([judge(cardA, cardB), judge(cardB, cardA)])
     outcome from A's view:
        both say A  → 1 ;  both say B → 0 ;  disagree or either 'tie' → 0.5, position_bias = true
     (ranking.md may weight by confidence; this doc only guarantees the fields exist.)
6. Per match, one RPC: apply_match_result(queue_id, outcome, judge_model, ab, ba, usage)
     — inserts matches row, updates both ratings rows, appends rating_history, marks queue done,
       flips resumes.status placing→ranked and sets ratings.provisional=false when the resume's
       placement matches are all done, record_usage('run-matches', …). SECURITY DEFINER, owned by
       the ranking doc.
7. Stop early when (budget − spent_this_tick) < 2 cents; unclaimed-but-claimed rows go back to
   'queued' with attempts decremented. Return {done, failed, skipped, cents}.
8. Wall clock: cap the loop at 100 s (Free) so we never hit the 150 s limit mid-batch; what is
   not finished is released back to the queue.
```

Judge call (same system prompt for every pair → cached; cards are small):

```ts
const JudgeSchema = z.object({
  winner: z.enum(["a", "b", "tie"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(240),
});
const res = await withRetry(() => anthropic.messages.parse({
  model: settings.judge_model,                           // claude-sonnet-5-5
  max_tokens: 600,
  thinking: { type: "adaptive" },
  output_config: { effort: "low", format: zodOutputFormat(JudgeSchema) },
  system: [{ type: "text", text: JUDGE_SYSTEM_PROMPT(category), cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: `Category: ${category}\n\nCANDIDATE A\n${renderCard(a)}\n\nCANDIDATE B\n${renderCard(b)}` }],
}), { tries: 3, deadlineMs: 40_000 });
```

The judge prompt (owned by `analysis-rubric.md`) tells the model it is a hiring committee for that
category, lists what counts (selectivity of institutions and employers, scope and measurable
impact, trajectory relative to career stage, research output for academia, deal/fund calibre for
finance, technical depth and shipped scale for tech) and what does not (formatting, length,
buzzwords, name or demographics — none of which it can see). Both orderings are always judged;
`position_bias` rows are the main judge-quality metric in the admin view.

### 3.4 `arena`

Human head-to-heads. Anyone can look; voting needs a session. Decision: use **Supabase anonymous
sign-ins** (`supabase.auth.signInAnonymously()`), so every voter has an `auth.uid()`, a profile row,
and an `arena_sessions` row — one identity model for RLS, rate limits and trust, no cookie
plumbing of our own. Signed-in users vote as themselves. Votes are never shown to the voter's
own resumes (`resume.owner_id <> voter`).

Requests (`POST /functions/v1/arena`, JSON body with `action`):

```
{ action: "pair", category }
  → requireUser (anonymous ok); rate limit 'arena_pair' 60/min per uid.
  → pick pair: random anchor rating in the category's pool:
       SELECT resume_id, rating FROM ratings WHERE category=$1 AND retired=false
         AND rating >= $anchor ORDER BY rating LIMIT 1   -- anchor = uniform sample of [p5, p95]
       then second card within ±150 rating excluding the first and the voter's own resumes,
       via the same index; fall back to any random row if the band is empty.
     with probability 1/25 (and only once the voter has ≥3 votes) substitute a HONEYPOT:
       one real card vs a stored control card (a deliberately thin, implausible resume from a
       fixtures table `arena_controls`). The expected answer is the real card.
  → pair_token = base64url(HMAC-SHA256(CRON_SECRET-derived key, `${uid}|${a}|${b}|${cat}|${honeypot}|${issued_ms}`)) + '.' + payload
  → 200 { pair_token, category, a: card, b: card }     (no resume_ids in the payload; they live in the token)

{ action: "vote", pair_token, choice: 'a'|'b'|'tie'|'skip' }
  → requireUser; verify HMAC + token age ≤ 10 min + token uid == caller; rate limit 'arena_vote' 30/min.
  → INSERT arena_votes (pair_token unique → replay returns 200 {duplicate:true} without effect)
  → decided_ms = now − issued_ms; if decided_ms < 1200 ms → counted=false (too fast to have read).
  → honeypot: counted=false; if choice == control → arena_sessions.honeypot_fails += 1.
  → else if arena_sessions.trusted (≥5 votes, 0 honeypot fails) and choice in (a,b,tie) and both
    resumes still active → apply_match_result(source='arena', outcome, voter_id) with the low-K /
    low-weight path defined in ranking.md; counted=true.
  → 200 { counted, your_streak, reveal: { a: {rating, rank}, b: {rating, rank} } }  -- the reveal is the engagement hook
```

Honeypot and "first 5 votes don't count" are invisible to the voter; the UI shows the reveal
either way. Untrusted sessions' votes are still stored (for later calibration) but have no rating
effect. `arena_paused` turns the vote path off while leaving pairs browsable.

### 3.5 `delete-account`

`POST /functions/v1/delete-account {}` with the user's JWT. Requires a fresh session (JWT `iat`
within 10 minutes — the UI re-prompts sign-in before showing the red button).

```
1. requireUser → uid.
2. admin().storage.from('resumes').list(uid + '/') → remove(all paths). Loop until empty (list pages at 100).
3. admin().auth.admin.deleteUser(uid)   -- cascades: profiles → resumes → ratings/matches/rating_history/
                                           match_queue/analysis_jobs/arena_votes/arena_sessions
4. Opponents' history: matches rows involving the deleted resumes are gone; their rating_history
   rows remain (match_id set null) so opponents' rating curves are intact. Ratings already applied
   are not reverted — same as a chess player closing their account.
5. 200 {}. Client signs out and shows "Everything's gone." Copy avoids being cute about it.
```

Also exposed as a single-resume delete (plain `DELETE` on `resumes` under RLS + storage delete
policy) for "remove this resume but keep my account".

---

## 4. Privacy and PII

What exists, who can see it:

| Data | Owner | Public | Workers | Notes |
|---|---|---|---|---|
| PDF in Storage | yes | never | service role only | signed URL only ever minted for the owner |
| `resumes.analysis` | yes | never | write-once | full feedback incl. scores |
| `resumes.card` | yes | yes (view) | read | anonymized; the only public artifact |
| `profiles.handle/display_name` | yes | if `visibility='public'` | — | default is anonymous |
| email (auth.users) | yes | never | never selected | not in any public view |
| ratings/matches | own rows | aggregate only via leaderboard | write | opponent ids only |

Anonymization is layered:

1. **Prompt-level.** The analysis system prompt instructs: the card must contain no name,
   email, phone, street address, city-level address, URL, social handle, photo description,
   date of birth, or visa status; institutions, employers, titles, dates and achievements are
   kept because they are the signal. The schema's `card` description repeats it and the model
   reports what it stripped in `pii_detected` (owner sees this as "we removed your email and
   phone from your public card").
2. **Regex post-pass** on every string in `card` (`_shared/pii.ts`), applied before the card is
   stored and again by `supersede/refresh` jobs when the rubric changes:
   ```ts
   const RULES: [RegExp, string][] = [
     [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]"],
     [/(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "[phone]"],
     [/\b(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|io|dev|me|ai|org|net|edu)\/\S*/gi, "[link]"],
     [/\b(?:linkedin\.com|github\.com|x\.com|twitter\.com)\/\S+/gi, "[link]"],
     [/\b\d{1,5}\s+[A-Z][a-z]+(?:\s[A-Z][a-z]+)*\s(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Dr|Drive|Ln|Lane)\b\.?/g, "[address]"],
   ];
   ```
   If the post-pass replaced anything, `pii_detected` gets `'other'` appended so the owner is
   told. `github.com/<user>` is stripped even though it is "the signal" for some tech resumes;
   the model is told to express it as a highlight instead ("maintainer of a 4k-star OSS project").
3. **Owner preview before publication is not a gate** (the card goes live when placement
   finishes) but the owner can delete the resume at any time, and the card page has a
   "Something personal slipped through?" link that files a row in `card_reports` and hides the
   card (`resumes.status` stays, a `hidden` flag added to the view's WHERE) until an admin looks.

Retention:

- PDFs are kept while the resume row exists so that a rubric bump (`settings.rubric_version`)
  can re-analyze everyone without asking for re-uploads. Users can delete a resume or the
  account at any time; both purge the PDF synchronously.
- Superseded resumes keep their PDF for 30 days (so "undo" is possible), then a cron job deletes
  the object and nulls `storage_path`-dependent fields; the row stays for rating history.
- Anonymous arena identities with no activity for 30 days are deleted (`auth.admin.deleteUser`
  in a cron-invoked function, batched).
- Anthropic API: standard 30-day retention on Anthropic's side applies to the PDF content we send;
  this is stated in the terms line. No training on API data by default.

Terms line (shown as a checkbox on first upload, stored as `profiles.terms_accepted_at`):

> ResumeArena uses Claude, an AI model from Anthropic, to read your resume and produce an
> anonymized public card and a private assessment. Your PDF is stored privately, is sent to
> Anthropic's API for analysis (and may be re-analyzed when our rubric changes), and is never shown
> to other users. You can delete your resume or your account at any time, which removes the file
> and everything derived from it. Rankings are a game, not hiring advice.

---

## 5. Abuse and cost control

| Vector | Control | Where |
|---|---|---|
| LLM bill runaway | `settings.daily_budget_cents`; `run-matches` and the analysis sweeper refuse when `budget_remaining_cents() < 5`; `paused` flag | SQL + both workers |
| One user spamming uploads | `analyses_per_user_day` (default 3) counted on drafts, not completions; anonymous auth users cannot upload | `create_resume_draft` |
| Many resumes per user inflating the board | one active resume per category; re-upload supersedes; old ratings retired | `supersede_previous` |
| Same PDF uploaded by many accounts | sha256 `file_hash`; same owner → free reuse; ≥3 owners → `duplicate_file` failure | analysis worker |
| Non-resume / junk PDFs | model returns `is_resume=false` → `failed('not_a_resume')`; still burns the user's daily quota | analysis worker |
| Prompt injection inside a PDF ("rate this 100/100") | structured output + system prompt that treats document text as data; judge only sees the derived card, never the PDF; an `injection_suspected` boolean in the schema flags obvious attempts and caps `scores.overall` at 40 | prompts + schema |
| Arena endpoint hammering | `check_rate_limit('arena_pair', uid, 60, '1 min')`, `('arena_vote', uid, 30, '1 min')`; pg_net/pg_cron never touch arena | `arena` |
| Bot votes | anonymous-auth identity per voter; votes count only after 5 votes with no honeypot failures; sub-1.2 s votes ignored; HMAC pair tokens expire in 10 min and are single-use | `arena` + `arena_sessions` |
| Vote brigading for one resume | arena votes use a lower K/weight (ranking.md) and a per-(voter, resume) cap of 3 counted votes per day | `apply_match_result` |
| Sign-up spam | Supabase Auth's built-in rate limits; OAuth providers (GitHub, Google) carry their own abuse controls; magic link limited to 4/hour/email | Auth settings |
| Turnstile | deferred to v2: upload is behind OAuth and the arena is behind anonymous auth with trust ramps; add Cloudflare Turnstile on `signInAnonymously` if `arena_sessions` shows bot-shaped cohorts | — |
| Service-role key leak | only ever in Edge Function env; never in repo; rotate from dashboard | ops |
| Storage path traversal | regex-pinned path + row-existence check in the storage policy | §2.2 |

Worker safety: every claim has a lease (`claimed_at`) and a sweeper; `attempts` caps at 3 for
analysis and 3 for matches; failures are stored in `last_error` and surface in `admin_ops`.

---

## 6. Deployment and release

### 6.1 Repository layout

```
resumearena/
  .github/workflows/pages.yml          # SPA → GitHub Pages
  .github/workflows/supabase.yml       # migrations + functions → Supabase (on push to main touching supabase/)
  web/                                 # Vite + React 19 + TS (pnpm workspace member)
    public/                            # 404.html is generated, not committed
    src/
  supabase/
    config.toml
    migrations/
    functions/ (see §3)
    seed.sql                           # dev-only: fixtures, arena_controls, a few fake cards
  docs/design/
  package.json  pnpm-workspace.yaml  .nvmrc (24)
```

### 6.2 GitHub Pages workflow

```yaml
# .github/workflows/pages.yml
name: pages
on:
  push: { branches: [main], paths: ['web/**', '.github/workflows/pages.yml'] }
  workflow_dispatch:
permissions: { contents: read, pages: write, id-token: write }
concurrency: { group: pages, cancel-in-progress: true }
jobs:
  build:
    runs-on: ubuntu-latest
    env:
      VITE_SUPABASE_URL: ${{ vars.VITE_SUPABASE_URL }}
      VITE_SUPABASE_ANON_KEY: ${{ vars.VITE_SUPABASE_ANON_KEY }}   # public by design; RLS is the boundary
      VITE_BASE_PATH: /resumearena/
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10 }
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter web build          # vite build --base=/resumearena/
      - run: cp web/dist/index.html web/dist/404.html
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with: { path: web/dist }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: ${{ steps.deployment.outputs.page_url }} }
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

- `vite.config.ts`: `base: process.env.VITE_BASE_PATH ?? '/'`; router uses
  `<BrowserRouter basename={import.meta.env.BASE_URL}>`.
- **SPA fallback:** GitHub Pages serves `404.html` for unknown paths under a project site, so a
  copy of `index.html` as `404.html` makes deep links (`/resumearena/l/tech`, `/resumearena/r/<uuid>`)
  load the app, which then routes client-side. The response status is 404, which is irrelevant
  for an app behind auth and fine for the public leaderboard (no SEO ambitions in v1; if that
  changes, pre-render the four leaderboard pages at build time).
- Repository settings: Pages → Source = GitHub Actions. Repository variables (not secrets):
  `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. Nothing secret is ever baked into the bundle.
- No custom domain; `noahfinkelstein.github.io` root remains the portfolio.

### 6.3 Supabase side

`supabase/config.toml` (relevant parts):

```toml
project_id = "resumearena"

[api]
schemas = ["public", "storage"]
max_rows = 100                       # PostgREST hard page cap

[auth]
site_url = "https://noahfinkelstein.github.io/resumearena/"
additional_redirect_urls = ["https://noahfinkelstein.github.io/resumearena/**", "http://localhost:5173/**"]
enable_anonymous_sign_ins = true
[auth.rate_limit]
anonymous_users = 30                 # per hour per IP
email_sent = 4
[auth.external.github]
enabled = true
client_id = "env(GITHUB_CLIENT_ID)"
secret = "env(GITHUB_SECRET)"
[auth.external.google]
enabled = true
client_id = "env(GOOGLE_CLIENT_ID)"
secret = "env(GOOGLE_SECRET)"

[storage]
file_size_limit = "5MiB"

[edge_runtime]
policy = "per_worker"                # keeps waitUntil tasks alive in local dev

[functions.analyze-resume]
verify_jwt = false
[functions.run-matches]
verify_jwt = false
[functions.arena]
verify_jwt = false
[functions.delete-account]
verify_jwt = false
```

Dashboard-only settings (not in config.toml for hosted projects): Authentication → URL
Configuration → Site URL `https://noahfinkelstein.github.io/resumearena/`, Redirect URLs
`https://noahfinkelstein.github.io/resumearena/**` and `http://localhost:5173/**`; enable
Anonymous sign-ins; OAuth app callbacks point at `https://<ref>.supabase.co/auth/v1/callback`.

Secrets: `supabase secrets set ANTHROPIC_API_KEY=sk-ant-… CRON_SECRET=$(openssl rand -hex 32)`.
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.
The same `CRON_SECRET` goes into Vault for the cron SQL:

```sql
select vault.create_secret('<same hex>', 'cron_secret');
select vault.create_secret('https://<ref>.supabase.co', 'project_url');
```

### 6.4 pg_cron schedules

```sql
-- every minute: judge queued matches
select cron.schedule('run-matches', '* * * * *', $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/run-matches',
    headers := jsonb_build_object('Content-Type','application/json',
                 'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000);
$$);

-- every minute: sweep stale/queued analysis jobs
select cron.schedule('sweep-analysis', '* * * * *', $$ select net.http_post(/* … analyze-resume, body {"sweep":true} … */); $$);

-- every 2 minutes: leaderboard (see §1.10) + stats
-- nightly 04:00 UTC: enqueue_refresh(), purge rate_limits, purge superseded PDFs > 30 d (via function),
--                     delete anonymous users idle > 30 d (via function), delete abandoned 'uploaded' rows > 1 d
```

`pg_net` is fire-and-forget; its `net._http_response` table (kept 6 h) is what the admin view
reads to count failed cron invocations.

### 6.5 Release recipe (no Docker on this machine)

```bash
# one-time
brew install supabase/tap/supabase
supabase login
supabase link --project-ref <ref>            # prompts for DB password
supabase secrets set ANTHROPIC_API_KEY=… CRON_SECRET=…

# every release
supabase db push                              # applies new files in supabase/migrations
supabase functions deploy --use-api           # server-side bundling, no Docker required
                                              # add --prune once function names are stable
git push origin main                          # triggers pages.yml
```

CI equivalent (`.github/workflows/supabase.yml`, on push to `main` touching `supabase/**`):
`supabase/setup-cli@v1` → `supabase link --project-ref ${{ secrets.SUPABASE_PROJECT_ID }}` →
`supabase db push` → `supabase functions deploy --use-api`, with `SUPABASE_ACCESS_TOKEN` and
`SUPABASE_DB_PASSWORD` as repository secrets. Migrations are forward-only; a bad migration is
fixed by a new migration, never by editing an applied file.

Local dev without Docker: `supabase start` needs Docker, so local work runs against a second
hosted project (`resumearena-dev`) with `supabase link` switched by `--project-ref`; Edge
Functions are tested with `supabase functions serve` (which does run Docker-free via the
bundled edge runtime binary) pointed at the dev project's URL/keys in `supabase/.env.local`.

---

## 7. Observability

### 7.1 Admin SQL view

```sql
create view admin_ops with (security_invoker = false) as
with spend as (
  select day, sum(cost_cents) as cents, sum(calls) as calls, sum(errors) as errors
  from usage_ledger where day >= current_date - 13 group by day
),
queue as (
  select
    (select count(*) from match_queue  where status = 'queued')                           as matches_queued,
    (select count(*) from match_queue  where status = 'claimed' and claimed_at < now() - interval '10 min') as matches_stuck,
    (select count(*) from analysis_jobs where status = 'queued')                          as analyses_queued,
    (select count(*) from analysis_jobs where status = 'claimed' and claimed_at < now() - interval '5 min')  as analyses_stuck,
    (select count(*) from resumes where status = 'failed' and updated_at > now() - interval '24 h')          as failed_24h,
    (select count(*) from resumes where status = 'ranked')                                                  as ranked_total,
    (select count(*) from resumes where created_at > now() - interval '24 h')                               as uploads_24h,
    (select round(100.0 * avg(position_bias::int), 1) from matches where source = 'judge' and created_at > now() - interval '24 h') as judge_bias_pct_24h,
    (select count(*) from arena_votes where created_at > now() - interval '24 h')                           as votes_24h,
    (select count(*) from arena_sessions where honeypot_fails > 0)                                          as flagged_voters,
    (select count(*) from net._http_response where status_code >= 400 and created > now() - interval '6 h') as cron_http_errors_6h,
    budget_remaining_cents()                                                                                as budget_left_cents
)
select s.day, s.cents, s.calls, s.errors, q.* from spend s cross join queue q order by s.day desc;
-- no grants: readable only from the SQL editor / service role
```

Plus `select * from cron.job_run_details order by start_time desc limit 50` for cron health and
Supabase's built-in Edge Function logs (filter by `function_name`). Each worker logs one JSON line
per unit of work: `{fn, worker, id, ms, model, in, out, cents, err}`; nothing from the PDF or card
text is ever logged.

Alerting in v1 is a human looking at `admin_ops` from a bookmarked SQL snippet; the first
automation to add is a daily cron that `net.http_post`s the top row to a private Discord webhook.

### 7.2 Client errors

v1: `window.addEventListener('error' | 'unhandledrejection')` → `console.error` with a
`[resumearena]` prefix, plus a React error boundary with a plain "Something broke. Reload, and if
it keeps happening, email …" panel. No third-party error service, no analytics script. The Supabase
client's own request errors are surfaced inline where they happen (upload, analyze, vote) with
the user-safe `failure_reason` strings mapped to copy:

| code | copy |
|---|---|
| `daily_limit` | You've used today's three analyses. Come back tomorrow. |
| `not_a_resume` | We couldn't read this as a resume. Try exporting the original document as a PDF. |
| `duplicate_file` | This exact file has already been entered by other accounts. |
| `file_too_large` | PDFs up to 5 MB. |
| `paused` | Uploads are paused for maintenance. The leaderboard still works. |
| `declined` | The model declined to analyze this file. |
| `analysis_failed` | Analysis failed on our side. Your daily count wasn't charged. (Refund handled by deleting the draft row.) |

---

## 8. Open questions for Noah

1. Daily budget default is $15. Confirm, and whether to start with `judge_model = claude-haiku-4-5`
   until there's a sense of judge quality vs. cost (position-bias % is the metric to watch).
2. Visibility default is `anonymous`. Alternative: ask at first upload with no default. The
   anonymous default is the safer launch; flipping is one line.
3. Anonymous arena voting (via Supabase anonymous auth) vs. requiring sign-in to vote. Anonymous
   maximizes the engagement loop; sign-in-required simplifies abuse control. Design assumes anonymous.
4. `general` is mandatory for every resume so the main board is complete. Confirm.
5. Free vs. Pro Supabase plan at launch: Free's 150 s wall-clock is fine for the design above, but
   Free projects pause after a week of inactivity, which would stop cron. Pro ($25/mo) is the
   recommendation once there are real users.
