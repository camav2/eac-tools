-- ────────────────────────────────────────────────────────────────────────────
-- EAC Tend — schema
--
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- Two tables. `tend_agents` is the roster: who each teammate is, what it is
-- allowed to touch, and when it wakes up. `tend_runs` is the audit log: one
-- row per execution, holding the full message transcript so a run paused for
-- approval can be resumed exactly where it stopped.
--
-- Service-key access only — every read and write goes through api/ handlers
-- that check the admin session first, so RLS is left enabled with no policies
-- (the service key bypasses it; nothing else can reach these tables).
-- ────────────────────────────────────────────────────────────────────────────

-- Who this install belongs to. One row, always id 'default'.
--
-- Everything an agent needs to know about the business lives here rather than
-- in a string literal in the prompt, so a second community can run Tend by
-- editing a form instead of a source file. The row below is seeded with EAC's
-- real values: customer zero must not have to configure an empty shell.
create table if not exists tend_workspace (
  id             text primary key default 'default',
  community_name text        not null default '',
  operator_name  text        not null default '',
  admin_name     text        not null default '',
  about          text        not null default '',
  style_notes    text        not null default '',
  updated_at     timestamptz not null default now(),
  -- Belt and braces: the single row is a product decision, not a convention
  -- someone should be able to break with one stray insert.
  constraint tend_workspace_single_row check (id = 'default')
);

insert into tend_workspace (id, community_name, operator_name, admin_name, about, style_notes)
values (
  'default',
  'the Expert Author Community (EAC)',
  'Kelly Irving',
  'Cameron McGrane',
  'EAC is a paid community for expert authors writing serious nonfiction books. '
  || 'Members join in intakes and work through a book-planning curriculum '
  || '(purpose, positioning, audience, and so on). Member wins worth surfacing '
  || 'are book launches, publication dates, and public milestones. The community '
  || 'runs on Circle; books and authors are published to a Webflow site; people '
  || 'and activity are tracked in Airtable.',
  'No hype and no exclamation marks. Never write copy that reads as a testimonial '
  || 'for EAC or for Kelly. Prefer a hyphen or a comma to an em dash.'
)
on conflict (id) do nothing;

create table if not exists tend_agents (
  id                uuid primary key default gen_random_uuid(),
  name              text        not null,
  role              text        not null default '',
  instructions      text        not null default '',
  -- Tool names from api/_lib/tend-tools.ts. Empty means the agent can only
  -- think and report, which is a legitimate (and safe) starting point.
  tools             text[]      not null default '{}',
  -- When true, any tool that changes the outside world stops the run and waits
  -- for Cam. Default true on purpose: an agent that can email members without
  -- a human in the loop is a different risk class to one that only reads.
  approval_required boolean     not null default true,
  effort            text        not null default 'medium',
  -- Provider id and model id from api/_lib/tend-providers.ts.
  provider          text        not null default 'anthropic',
  model             text        not null default 'claude-opus-5',
  -- manual | hourly | daily | weekly
  schedule          text        not null default 'manual',
  hour_utc          int         not null default 21,
  dow               int         not null default 1,   -- 0=Sun .. 6=Sat, weekly only
  enabled           boolean     not null default true,
  last_run_at       timestamptz,
  created_at        timestamptz not null default now()
);

create table if not exists tend_runs (
  id            uuid primary key default gen_random_uuid(),
  agent_id      uuid        not null references tend_agents(id) on delete cascade,
  -- Denormalised so the log still reads correctly after an agent is renamed
  -- or deleted.
  agent_name    text        not null default '',
  -- running | awaiting_approval | completed | failed | rejected
  status        text        not null default 'running',
  trigger       text        not null default 'manual',   -- manual | schedule
  -- Pinned from the agent when the run starts. The transcript below is in
  -- this provider's native shape, so a resume must use the same one.
  provider      text        not null default 'anthropic',
  model         text        not null default 'claude-opus-5',
  summary       text,
  error         text,
  -- Verbatim Anthropic messages array, thinking blocks included. Required for
  -- resume: extended thinking blocks carry signatures that must be replayed
  -- unmodified or the continuation is rejected.
  messages      jsonb       not null default '[]'::jsonb,
  -- Human-readable trail: one entry per tool call, with arguments and result.
  log           jsonb       not null default '[]'::jsonb,
  -- The tool call held at an approval gate: { toolUseId, name, input }
  pending       jsonb,
  input_tokens  int         not null default 0,
  output_tokens int         not null default 0,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);

-- For an install that ran an earlier version of this file. No-ops otherwise.
alter table tend_agents add column if not exists provider text not null default 'anthropic';
alter table tend_agents add column if not exists model    text not null default 'claude-opus-5';
alter table tend_runs   add column if not exists provider text not null default 'anthropic';
alter table tend_runs   add column if not exists model    text not null default 'claude-opus-5';

create index if not exists tend_runs_agent_started_idx
  on tend_runs (agent_id, started_at desc);

create index if not exists tend_runs_status_idx
  on tend_runs (status)
  where status = 'awaiting_approval';

alter table tend_workspace enable row level security;
alter table tend_agents    enable row level security;
alter table tend_runs      enable row level security;
