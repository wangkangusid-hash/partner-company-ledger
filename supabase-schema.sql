create table if not exists public.ledger_entries (
  id uuid primary key,
  entry_date date not null,
  entry_type text not null check (entry_type in ('income', 'expense')),
  amount numeric(12, 2) not null check (amount > 0),
  category text not null default '未分类',
  note text not null default '',
  image jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ledger_entries_entry_date_idx on public.ledger_entries (entry_date desc);
create index if not exists ledger_entries_created_at_idx on public.ledger_entries (created_at desc);
