-- ============================================================
-- 3DigitalShop — Schema Principal (Supabase SQL Editor)
-- Versão 3.0 | Execute este ficheiro primeiro
-- ============================================================

-- ── EXTENSÕES ────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── PLANOS ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS planos (
  id            TEXT PRIMARY KEY,  -- 'amador', 'simples', etc.
  nome          TEXT NOT NULL,
  ton           NUMERIC(10,4) NOT NULL DEFAULT 0,
  max_produtos  INT NOT NULL DEFAULT 1,
  max_imgs      INT NOT NULL DEFAULT 2,
  suporte       TEXT NOT NULL DEFAULT 'básico',
  ordem         INT NOT NULL DEFAULT 0,
  ativo         BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO planos (id, nome, ton, max_produtos, max_imgs, suporte, ordem) VALUES
  ('amador',        'Amador',        0.5,  1,  2, 'básico',        1),
  ('simples',       'Simples',       1.5,  3,  3, 'básico',        2),
  ('iniciante',     'Iniciante',     3.0,  5,  4, 'e-mail',        3),
  ('basico',        'Básico',        5.0,  10, 5, 'e-mail',        4),
  ('classico',      'Clássico',      8.0,  20, 6, 'prioritário',   5),
  ('profissional',  'Profissional', 10.0,  50, 8, 'VIP 24/7',      6)
ON CONFLICT (id) DO NOTHING;

-- ── LOJISTAS ─────────────────────────────────────────────────
-- Espelha auth.users; criado via trigger
CREATE TABLE IF NOT EXISTS lojistas (
  id               UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email            TEXT NOT NULL,
  nome_loja        TEXT,
  descricao        TEXT,
  logo_url         TEXT,
  banner_url       TEXT,
  slug             TEXT UNIQUE,
  link_mascarado   TEXT UNIQUE,
  plano_id         TEXT NOT NULL DEFAULT 'amador' REFERENCES planos(id),
  plano_expira_em  TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','suspended')),
  total_cliques    INT NOT NULL DEFAULT 0,
  instagram        TEXT,
  facebook         TEXT,
  tiktok           TEXT,
  youtube          TEXT,
  website          TEXT,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actualizado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger: criar registo em lojistas após signup
CREATE OR REPLACE FUNCTION criar_lojista_apos_signup()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.lojistas (id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION criar_lojista_apos_signup();

-- ── PRODUTOS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS produtos (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lojista_id     UUID NOT NULL REFERENCES lojistas(id) ON DELETE CASCADE,
  nome           TEXT NOT NULL,
  descricao      TEXT,
  preco          NUMERIC(10,2),
  imagens        TEXT[] DEFAULT '{}',
  categoria      TEXT,
  tags           TEXT[] DEFAULT '{}',
  link_externo   TEXT NOT NULL,
  provedor       TEXT,
  seo_titulo     TEXT,
  seo_descricao  TEXT,
  ativo          BOOLEAN NOT NULL DEFAULT TRUE,
  total_cliques  INT NOT NULL DEFAULT 0,
  total_views    INT NOT NULL DEFAULT 0,
  media_reviews  NUMERIC(3,2) NOT NULL DEFAULT 0,
  total_reviews  INT NOT NULL DEFAULT 0,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── PAGAMENTOS ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pagamentos (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lojista_id      UUID NOT NULL REFERENCES lojistas(id) ON DELETE CASCADE,
  plano_id        TEXT NOT NULL REFERENCES planos(id),
  valor_ton       NUMERIC(14,8) NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'TONCOIN',
  invoice_id      TEXT NOT NULL UNIQUE,
  invoice_link    TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','expired','failed')),
  ref_afiliado    TEXT,
  confirmado_em   TIMESTAMPTZ,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── AFILIADOS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS afiliados (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id            UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  email              TEXT NOT NULL,
  nome               TEXT,
  codigo             TEXT NOT NULL UNIQUE,
  carteira_ton       TEXT,
  ativo              BOOLEAN NOT NULL DEFAULT TRUE,
  total_cliques      INT NOT NULL DEFAULT 0,
  total_conversoes   INT NOT NULL DEFAULT 0,
  saldo_disponivel   NUMERIC(14,8) NOT NULL DEFAULT 0,
  saldo_pago         NUMERIC(14,8) NOT NULL DEFAULT 0,
  criado_em          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actualizado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── AFILIADO CLIQUES ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS afiliado_cliques (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  afiliado_id  UUID NOT NULL REFERENCES afiliados(id) ON DELETE CASCADE,
  ip           TEXT,
  user_agent   TEXT,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── AFILIADO COMISSÕES ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS afiliado_comissoes (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  afiliado_id    UUID NOT NULL REFERENCES afiliados(id) ON DELETE CASCADE,
  lojista_id     UUID REFERENCES lojistas(id) ON DELETE SET NULL,
  plano_id       TEXT REFERENCES planos(id),
  valor_ton      NUMERIC(14,8) NOT NULL,
  percentagem    NUMERIC(5,2) NOT NULL DEFAULT 10,
  referencia_id  TEXT NOT NULL UNIQUE,  -- invoice_id
  status         TEXT NOT NULL DEFAULT 'disponivel' CHECK (status IN ('disponivel','pago','cancelado')),
  pago_em        TIMESTAMPTZ,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── AFILIADO SAQUES ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS afiliado_saques (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  afiliado_id       UUID NOT NULL REFERENCES afiliados(id) ON DELETE CASCADE,
  valor_ton         NUMERIC(14,8) NOT NULL,
  carteira_destino  TEXT NOT NULL,
  taxa_rede         NUMERIC(14,8) NOT NULL DEFAULT 0.01,
  valor_liquido     NUMERIC(14,8) NOT NULL,
  status            TEXT NOT NULL DEFAULT 'processando' CHECK (status IN ('processando','pendente','pago','falhado')),
  tx_hash           TEXT,
  processado_em     TIMESTAMPTZ,
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── AUTOMAÇÕES ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS automacoes (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lojista_id   UUID NOT NULL REFERENCES lojistas(id) ON DELETE CASCADE,
  tipo         TEXT NOT NULL,
  nome         TEXT NOT NULL,
  ativa        BOOLEAN NOT NULL DEFAULT FALSE,
  config       JSONB DEFAULT '{}',
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lojista_id, tipo)
);

-- ── AI CONVERSAS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_conversas (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lojista_id      UUID REFERENCES lojistas(id) ON DELETE CASCADE,
  contexto        TEXT NOT NULL CHECK (contexto IN ('lojista','afiliado','admin')),
  mensagens       JSONB NOT NULL DEFAULT '[]',
  actualizado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, contexto)
);

-- ── CONFIGURAÇÃO DA PLATAFORMA ───────────────────────────────
CREATE TABLE IF NOT EXISTS config_plataforma (
  id                  INT PRIMARY KEY DEFAULT 1,
  nome_plataforma     TEXT NOT NULL DEFAULT '3DigitalShop',
  xrocket_api_key     TEXT,
  gemini_api_key      TEXT,
  anthropic_api_key   TEXT,
  ton_usd_rate        NUMERIC(10,4) NOT NULL DEFAULT 5,
  comissao_afiliado   NUMERIC(5,2) NOT NULL DEFAULT 10,
  taxa_rede_ton       NUMERIC(14,8) NOT NULL DEFAULT 0.01,
  dominio_plataforma  TEXT DEFAULT 'https://digimarket-h0vk.onrender.com',
  actualizado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT config_single_row CHECK (id = 1)
);

INSERT INTO config_plataforma (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- ── ÍNDICES ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_produtos_lojista   ON produtos(lojista_id);
CREATE INDEX IF NOT EXISTS idx_pagamentos_lojista ON pagamentos(lojista_id);
CREATE INDEX IF NOT EXISTS idx_pagamentos_status  ON pagamentos(status);
CREATE INDEX IF NOT EXISTS idx_afiliados_codigo   ON afiliados(codigo);
CREATE INDEX IF NOT EXISTS idx_afiliados_user     ON afiliados(user_id);
CREATE INDEX IF NOT EXISTS idx_comissoes_afiliado ON afiliado_comissoes(afiliado_id);
CREATE INDEX IF NOT EXISTS idx_saques_afiliado    ON afiliado_saques(afiliado_id);
CREATE INDEX IF NOT EXISTS idx_cliques_afiliado   ON afiliado_cliques(afiliado_id);
CREATE INDEX IF NOT EXISTS idx_automacoes_lojista ON automacoes(lojista_id);

-- ── ROW LEVEL SECURITY ───────────────────────────────────────
ALTER TABLE lojistas          ENABLE ROW LEVEL SECURITY;
ALTER TABLE produtos           ENABLE ROW LEVEL SECURITY;
ALTER TABLE pagamentos         ENABLE ROW LEVEL SECURITY;
ALTER TABLE afiliados          ENABLE ROW LEVEL SECURITY;
ALTER TABLE afiliado_cliques   ENABLE ROW LEVEL SECURITY;
ALTER TABLE afiliado_comissoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE afiliado_saques    ENABLE ROW LEVEL SECURITY;
ALTER TABLE automacoes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_conversas       ENABLE ROW LEVEL SECURITY;

-- Lojistas: vê e edita apenas o próprio
CREATE POLICY "lojista_self" ON lojistas
  FOR ALL USING (auth.uid() = id);

-- Produtos: CRUD apenas do próprio lojista; leitura pública dos activos
CREATE POLICY "produto_owner" ON produtos
  FOR ALL USING (auth.uid() = lojista_id);
CREATE POLICY "produto_public_read" ON produtos
  FOR SELECT USING (ativo = TRUE);

-- Pagamentos: vê apenas os próprios
CREATE POLICY "pagamento_self" ON pagamentos
  FOR ALL USING (auth.uid() = lojista_id);

-- Afiliados: vê e edita apenas o próprio
CREATE POLICY "afiliado_self" ON afiliados
  FOR ALL USING (auth.uid() = user_id);

-- Comissões: vê apenas as próprias
CREATE POLICY "comissao_self" ON afiliado_comissoes
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM afiliados WHERE id = afiliado_id AND user_id = auth.uid())
  );

-- Saques: vê apenas os próprios
CREATE POLICY "saque_self" ON afiliado_saques
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM afiliados WHERE id = afiliado_id AND user_id = auth.uid())
  );

-- Automações: próprio lojista
CREATE POLICY "automacao_self" ON automacoes
  FOR ALL USING (auth.uid() = lojista_id);

-- AI conversas: próprio utilizador
CREATE POLICY "ai_conversa_self" ON ai_conversas
  FOR ALL USING (auth.uid() = user_id);

-- Planos e config: leitura pública
CREATE POLICY "planos_public" ON planos FOR SELECT USING (TRUE);
ALTER TABLE planos         ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_plataforma ENABLE ROW LEVEL SECURITY;
CREATE POLICY "config_public_read" ON config_plataforma FOR SELECT USING (TRUE);

-- ── FUNÇÃO: INCREMENTAR CLIQUES AFILIADO ─────────────────────
CREATE OR REPLACE FUNCTION incrementar_cliques(afiliado_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE afiliados
  SET total_cliques = total_cliques + 1,
      actualizado_em = NOW()
  WHERE id = afiliado_id;
END;
$$;

-- ── FUNÇÃO: ACTUALIZAR TIMESTAMP ─────────────────────────────
CREATE OR REPLACE FUNCTION update_actualizado_em()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.actualizado_em = NOW(); RETURN NEW; END;
$$;

CREATE TRIGGER trg_lojistas_upd   BEFORE UPDATE ON lojistas   FOR EACH ROW EXECUTE FUNCTION update_actualizado_em();
CREATE TRIGGER trg_produtos_upd   BEFORE UPDATE ON produtos    FOR EACH ROW EXECUTE FUNCTION update_actualizado_em();
CREATE TRIGGER trg_afiliados_upd  BEFORE UPDATE ON afiliados   FOR EACH ROW EXECUTE FUNCTION update_actualizado_em();
