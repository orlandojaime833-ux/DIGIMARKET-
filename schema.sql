-- ════════════════════════════════════════════════════════
-- DIGIMarket — Schema completo Supabase
-- Cola isto no SQL Editor do Supabase e clica "Run"
-- ════════════════════════════════════════════════════════

-- Tabela de lojistas
create table if not exists public.lojistas (
  id uuid references auth.users on delete cascade primary key,
  email text not null,
  nome_loja text default 'A Minha Loja',
  descricao text,
  logo_url text,
  banner_url text,
  slug text unique,
  instagram text,
  facebook text,
  dominio_personalizado text,
  plano text default 'free' check (plano in ('free','standard','pro','business')),
  plano_expira_em timestamptz,
  status text default 'active' check (status in ('active','inactive')),
  criado_em timestamptz default now()
);

-- Tabela de produtos
create table if not exists public.produtos (
  id uuid default gen_random_uuid() primary key,
  lojista_id uuid references public.lojistas(id) on delete cascade,
  nome text not null,
  descricao text,
  preco numeric(10,2) not null default 0,
  imagens text[] default '{}',
  ativo boolean default true,
  criado_em timestamptz default now()
);

-- Tabela de pagamentos TON (multi-moeda)
create table if not exists public.pagamentos (
  id uuid default gen_random_uuid() primary key,
  lojista_id uuid references public.lojistas(id) on delete cascade,
  plano text not null,
  valor_crypto numeric(18,8) not null,
  currency text not null default 'TONCOIN',
  valor_usd numeric(10,2),
  invoice_id text unique,
  invoice_link text,
  tx_hash text,
  status text default 'pending' check (status in ('pending','confirmed','failed')),
  criado_em timestamptz default now(),
  confirmado_em timestamptz
);

-- Tabela de configurações da plataforma
create table if not exists public.config_plataforma (
  id int primary key default 1,
  ton_api_key text default '2b95ea2ad1f9a2d53563a05d4',
  ton_carteira_recepcao text,
  ton_usd_rate numeric(10,4) default 5.0,
  taxa_transacao numeric(5,2) default 2.5,
  preco_standard_ton numeric(10,4) default 2.5,
  preco_pro_ton numeric(10,4) default 7.0,
  preco_business_ton numeric(10,4) default 16.5,
  dominio_plataforma text default 'orlandojaime833-ux.github.io/DIGIMARKET-'
);

-- Inserir config inicial
insert into public.config_plataforma (id)
values (1)
on conflict (id) do nothing;

-- ════════════════════════════════════════════════════════
-- RLS (Row Level Security — segurança por utilizador)
-- ════════════════════════════════════════════════════════
alter table public.lojistas enable row level security;
alter table public.produtos enable row level security;
alter table public.pagamentos enable row level security;
alter table public.config_plataforma enable row level security;

-- Lojista gere apenas os seus dados
drop policy if exists "lojista_proprio" on public.lojistas;
create policy "lojista_proprio" on public.lojistas
  for all using (auth.uid() = id);

drop policy if exists "produtos_proprio" on public.produtos;
create policy "produtos_proprio" on public.produtos
  for all using (auth.uid() = lojista_id);

drop policy if exists "pagamentos_proprio" on public.pagamentos;
create policy "pagamentos_proprio" on public.pagamentos
  for all using (auth.uid() = lojista_id);

-- Lojas públicas visíveis a todos (para sub-lojas)
drop policy if exists "lojas_publicas" on public.lojistas;
create policy "lojas_publicas" on public.lojistas
  for select using (status = 'active');

drop policy if exists "produtos_publicos" on public.produtos;
create policy "produtos_publicos" on public.produtos
  for select using (ativo = true);

-- Config apenas via service_role (backend)
drop policy if exists "config_service_only" on public.config_plataforma;
create policy "config_service_only" on public.config_plataforma
  for all using (false);

-- ════════════════════════════════════════════════════════
-- Trigger: criar registo de lojista automaticamente
-- após registo no Supabase Auth
-- ════════════════════════════════════════════════════════
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.lojistas (id, email, slug)
  values (
    new.id,
    new.email,
    'loja-' || substring(new.id::text, 1, 8)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
