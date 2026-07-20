-- ═══════════════════════════════════════════════════════════════
--  सड़क परियोजना प्रबंधन प्रणाली — Supabase Database Schema
--  PostgreSQL + JSONB storage model
-- ═══════════════════════════════════════════════════════════════
--
--  कैसे चलाएँ:
--  1. https://supabase.com → अपना Project खोलें
--  2. SQL Editor → New Query → यह पूरी फ़ाइल paste करें → RUN
--  3. Storage → New bucket → नाम: rms-files → "Public bucket" ON करें
--  4. Project Settings → API से URL और service_role key कॉपी करें
--     (Netlify के Environment Variables में डालनी हैं — CLOUD-SETUP.md देखें)
--
--  डेटा-मॉडल:
--    spreadsheets  → हर "वर्कबुक" (मुख्य DB + हर भुगतान-परियोजना)
--    sheets        → वर्कबुक की tables (1_Roads_Master, 3_Projects, ...)
--    sheet_rows    → हर पंक्ति JSONB array के रूप में (row 1 = header)
--    files         → अपलोड फ़ाइलों का metadata (असली फ़ाइल Storage bucket में)
--
--  सभी read/write नीचे दिए RPC functions से होते हैं जिन्हें
--  Netlify Function (netlify/functions/db.mjs) कॉल करता है।
-- ═══════════════════════════════════════════════════════════════

-- ── Tables ──────────────────────────────────────────────────────

create table if not exists public.spreadsheets (
  id         text primary key,
  name       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sheets (
  id             bigint generated always as identity primary key,
  spreadsheet_id text not null references public.spreadsheets(id) on delete cascade,
  name           text not null,
  created_at     timestamptz not null default now(),
  unique (spreadsheet_id, name)
);

create table if not exists public.sheet_rows (
  id        bigint generated always as identity primary key,
  sheet_id  bigint not null references public.sheets(id) on delete cascade,
  row_index int    not null,          -- 1-based; row 1 = header
  cells     jsonb  not null default '[]'::jsonb,
  unique (sheet_id, row_index)
);

create index if not exists idx_sheet_rows_sheet on public.sheet_rows(sheet_id, row_index);

create table if not exists public.files (
  id         uuid primary key default gen_random_uuid(),
  bucket     text not null default 'rms-files',
  path       text not null unique,    -- Storage bucket के अंदर का path
  name       text not null,           -- मूल फ़ाइल-नाम
  folder     text not null default '',-- तार्किक फ़ोल्डर (जैसे 'Road Management System/Letters')
  mime       text,
  size       bigint,
  created_at timestamptz not null default now()
);

create index if not exists idx_files_folder on public.files(folder);

-- ── RLS ─────────────────────────────────────────────────────────
-- सिर्फ़ server (Apps Script, service_role key) ही इन tables को छूता है।
-- RLS ON + कोई policy नहीं = anon/public से पूरी तरह बंद;
-- service_role key RLS bypass करती है।

alter table public.spreadsheets enable row level security;
alter table public.sheets       enable row level security;
alter table public.sheet_rows   enable row level security;
alter table public.files        enable row level security;

-- ── Helper: sheet id ढूँढें/बनाएँ ────────────────────────────────

create or replace function public._ss_sheet_id(p_ss text, p_sheet text)
returns bigint
language sql stable
as $$
  select s.id from public.sheets s
  where s.spreadsheet_id = p_ss and s.name = p_sheet;
$$;

create or replace function public._ss_touch(p_ss text)
returns void
language sql
as $$
  update public.spreadsheets set updated_at = now() where id = p_ss;
$$;

-- ── RPC: वर्कबुक प्रबंधन ─────────────────────────────────────────

create or replace function public.ss_create_spreadsheet(p_id text, p_name text)
returns text
language plpgsql
as $$
begin
  insert into public.spreadsheets(id, name) values (p_id, p_name)
  on conflict (id) do nothing;
  return p_id;
end;
$$;

create or replace function public.ss_list_spreadsheets()
returns jsonb
language sql stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'name', name,
           'updated', to_char(updated_at, 'YYYY-MM-DD HH24:MI'))
           order by updated_at desc), '[]'::jsonb)
  from public.spreadsheets;
$$;

create or replace function public.ss_rename_spreadsheet(p_id text, p_name text)
returns void
language sql
as $$
  update public.spreadsheets set name = p_name, updated_at = now() where id = p_id;
$$;

create or replace function public.ss_delete_spreadsheet(p_id text)
returns void
language sql
as $$
  delete from public.spreadsheets where id = p_id;
$$;

-- ── RPC: sheet प्रबंधन ───────────────────────────────────────────

create or replace function public.ss_ensure_sheet(p_ss text, p_sheet text)
returns bigint
language plpgsql
as $$
declare v_id bigint;
begin
  insert into public.spreadsheets(id, name) values (p_ss, p_ss)
  on conflict (id) do nothing;
  insert into public.sheets(spreadsheet_id, name) values (p_ss, p_sheet)
  on conflict (spreadsheet_id, name) do nothing;
  select public._ss_sheet_id(p_ss, p_sheet) into v_id;
  return v_id;
end;
$$;

create or replace function public.ss_delete_sheet(p_ss text, p_sheet text)
returns void
language plpgsql
as $$
begin
  delete from public.sheets where spreadsheet_id = p_ss and name = p_sheet;
  perform public._ss_touch(p_ss);
end;
$$;

create or replace function public.ss_rename_sheet(p_ss text, p_old text, p_new text)
returns void
language plpgsql
as $$
begin
  update public.sheets set name = p_new
  where spreadsheet_id = p_ss and name = p_old;
  perform public._ss_touch(p_ss);
end;
$$;

-- ── RPC: पूरी वर्कबुक एक बार में पढ़ें ───────────────────────────
-- {"नाम-1": [[r1],[r2],...], "नाम-2": [...]} — Apps Script इसे
-- execution-भर memory में cache रखता है (एक HTTP call प्रति वर्कबुक)।

create or replace function public.ss_get_all(p_ss text)
returns jsonb
language sql stable
as $$
  select coalesce(jsonb_object_agg(t.name, t.rows), '{}'::jsonb)
  from (
    select s.name,
           coalesce((select jsonb_agg(r.cells order by r.row_index)
                     from public.sheet_rows r where r.sheet_id = s.id),
                    '[]'::jsonb) as rows
    from public.sheets s
    where s.spreadsheet_id = p_ss
  ) t;
$$;

-- ── RPC: पंक्ति जोड़ें ──────────────────────────────────────────

create or replace function public.ss_append_row(p_ss text, p_sheet text, p_cells jsonb)
returns int
language plpgsql
as $$
declare
  v_sheet bigint;
  v_row   int;
begin
  v_sheet := public.ss_ensure_sheet(p_ss, p_sheet);
  perform pg_advisory_xact_lock(v_sheet);  -- एक साथ दो append टकराएँ नहीं
  select coalesce(max(row_index), 0) + 1 into v_row
  from public.sheet_rows where sheet_id = v_sheet;
  insert into public.sheet_rows(sheet_id, row_index, cells)
  values (v_sheet, v_row, p_cells);
  perform public._ss_touch(p_ss);
  return v_row;
end;
$$;

-- ── RPC: cells लिखें (2D block, GAS setValues/setValue जैसा) ────
-- p_values = [[..],[..]] — p_row,p_col (1-based) से शुरू होकर लिखता है।
-- बीच की missing rows/cells अपने-आप '' से pad हो जाती हैं।

create or replace function public.ss_set_cells(p_ss text, p_sheet text, p_row int, p_col int, p_values jsonb)
returns void
language plpgsql
as $$
declare
  v_sheet  bigint;
  v_r      int;
  v_c      int;
  v_rowarr jsonb;
  v_cells  jsonb;
  v_need   int;
begin
  v_sheet := public.ss_ensure_sheet(p_ss, p_sheet);
  perform pg_advisory_xact_lock(v_sheet);

  for v_r in 0 .. jsonb_array_length(p_values) - 1 loop
    v_rowarr := p_values -> v_r;

    select cells into v_cells from public.sheet_rows
    where sheet_id = v_sheet and row_index = p_row + v_r;

    if v_cells is null then
      -- बीच की खाली rows भी बना दें ताकि row_index sequence टूटे नहीं
      insert into public.sheet_rows(sheet_id, row_index, cells)
      select v_sheet, g, '[]'::jsonb
      from generate_series(
             (select coalesce(max(row_index),0)+1 from public.sheet_rows where sheet_id = v_sheet),
             p_row + v_r) g
      on conflict (sheet_id, row_index) do nothing;
      v_cells := '[]'::jsonb;
    end if;

    -- cells array को ज़रूरत की चौड़ाई तक '' से pad करें
    v_need := p_col - 1 + jsonb_array_length(v_rowarr);
    while jsonb_array_length(v_cells) < v_need loop
      v_cells := v_cells || '""'::jsonb;
    end loop;

    for v_c in 0 .. jsonb_array_length(v_rowarr) - 1 loop
      v_cells := jsonb_set(v_cells, array[(p_col - 1 + v_c)::text], v_rowarr -> v_c, true);
    end loop;

    update public.sheet_rows set cells = v_cells
    where sheet_id = v_sheet and row_index = p_row + v_r;
  end loop;

  perform public._ss_touch(p_ss);
end;
$$;

-- ── RPC: पंक्ति हटाएँ (बाक़ी rows ऊपर खिसकती हैं, GAS deleteRow जैसा) ──

create or replace function public.ss_delete_row(p_ss text, p_sheet text, p_row int)
returns void
language plpgsql
as $$
declare v_sheet bigint;
begin
  v_sheet := public._ss_sheet_id(p_ss, p_sheet);
  if v_sheet is null then return; end if;
  perform pg_advisory_xact_lock(v_sheet);
  delete from public.sheet_rows where sheet_id = v_sheet and row_index = p_row;
  -- दो-चरण shift: unique(sheet_id,row_index) से transient टकराव न हो
  update public.sheet_rows set row_index = -(row_index - 1)
  where sheet_id = v_sheet and row_index > p_row;
  update public.sheet_rows set row_index = -row_index
  where sheet_id = v_sheet and row_index < 0;
  perform public._ss_touch(p_ss);
end;
$$;

-- ── RPC: range साफ़ करें (clearContent जैसा) ────────────────────

create or replace function public.ss_clear_range(p_ss text, p_sheet text, p_row int, p_col int, p_nrows int, p_ncols int)
returns void
language plpgsql
as $$
declare
  v_sheet bigint;
  v_rec   record;
  v_cells jsonb;
  v_c     int;
begin
  v_sheet := public._ss_sheet_id(p_ss, p_sheet);
  if v_sheet is null then return; end if;
  for v_rec in
    select id, cells from public.sheet_rows
    where sheet_id = v_sheet and row_index between p_row and p_row + p_nrows - 1
  loop
    v_cells := v_rec.cells;
    for v_c in p_col - 1 .. least(p_col - 2 + p_ncols, jsonb_array_length(v_cells) - 1) loop
      v_cells := jsonb_set(v_cells, array[v_c::text], '""'::jsonb, false);
    end loop;
    update public.sheet_rows set cells = v_cells where id = v_rec.id;
  end loop;
  perform public._ss_touch(p_ss);
end;
$$;

-- ── RPC: files metadata ─────────────────────────────────────────

-- (पुराना 5-parameter version हटाएँ ताकि overload-टकराव न हो)
drop function if exists public.ss_register_file(text, text, text, text, bigint);

create or replace function public.ss_register_file(p_id uuid, p_path text, p_name text, p_folder text, p_mime text, p_size bigint)
returns uuid
language plpgsql
as $$
begin
  insert into public.files(id, path, name, folder, mime, size)
  values (p_id, p_path, p_name, p_folder, p_mime, p_size)
  on conflict (id) do nothing;
  return p_id;
end;
$$;

create or replace function public.ss_file_by_id(p_id uuid)
returns jsonb
language sql stable
as $$
  select coalesce((select to_jsonb(f) from public.files f where f.id = p_id), 'null'::jsonb);
$$;

create or replace function public.ss_delete_file(p_id uuid)
returns text
language plpgsql
as $$
declare v_path text;
begin
  delete from public.files where id = p_id returning path into v_path;
  return v_path;  -- Apps Script इस path से Storage object भी हटाता है
end;
$$;

create or replace function public.ss_rename_file(p_id uuid, p_name text)
returns void
language sql
as $$
  update public.files set name = p_name where id = p_id;
$$;

-- ── Road Estimator का डेटा ──────────────────────────────────────
-- (हर browser के IndexedDB की जगह central storage —
--  sheets / estimates / master documents, JSONB में)

create table if not exists public.est_kv (
  store      text  not null,   -- 'sheets' | 'estimates' | 'master'
  id         text  not null,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  owner      text,             -- किस user का (estimates/sheets); master साझा (owner NULL)
  primary key (store, id)
);

alter table public.est_kv enable row level security;
alter table public.est_kv add column if not exists owner text;
-- मौजूदा estimates/sheets → Super Admin ('Admin') के (Phase 2 migration)
update public.est_kv set owner = 'Admin' where owner is null and store in ('estimates', 'sheets');

-- Estimator: तेज़ मिलान — गिनती + आख़िरी बदलाव समय (user-scoped; master साझा)
drop function if exists public.est_stamp();
create or replace function public.est_stamp(p_owner text default '')
returns jsonb
language sql stable
as $$
  select coalesce(jsonb_object_agg(store, jsonb_build_object('n', n, 'ts', ts)), '{}'::jsonb)
  from (
    select store, count(*) as n, max(updated_at) as ts
    from public.est_kv
    where store = 'master' or owner is not distinct from p_owner
    group by store
  ) t;
$$;

-- Estimator: तीनों stores का डेटा एक ही call में (user-scoped; master साझा)
drop function if exists public.est_all();
create or replace function public.est_all(p_owner text default '')
returns jsonb
language sql stable
as $$
  select coalesce(jsonb_object_agg(store, rows), '{}'::jsonb)
  from (
    select store, jsonb_agg(jsonb_build_object('id', id, 'data', data) order by id) as rows
    from public.est_kv
    where store = 'master' or owner is not distinct from p_owner
    group by store
  ) t;
$$;

-- ── App users (Admin द्वारा बनाए/प्रबंधित) ──────────────────────
-- passwords सिर्फ़ scrypt-hash (salt अलग) — plaintext कभी नहीं।
-- केवल server (service_role key, db.mjs) ही इसे छूता है — RLS ON + कोई policy नहीं।
create table if not exists public.app_users (
  username    text primary key,
  pass_hash   text not null,
  pass_salt   text not null,
  role        text not null default 'user',   -- 'admin' | 'user'
  name        text not null default '',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

alter table public.app_users enable row level security;

-- ── मुख्य वर्कबुक seed ───────────────────────────────────────────

select public.ss_create_spreadsheet('main', 'Road Management System');

-- ═══════════════════════════════════════════════════════════════
--  पूर्ण! अब Storage में 'rms-files' नाम का PUBLIC bucket बनाएँ,
--  फिर CLOUD-SETUP.md के अनुसार Netlify env variables सेट करें।
-- ═══════════════════════════════════════════════════════════════
