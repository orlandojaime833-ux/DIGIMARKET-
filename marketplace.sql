-- ============================================================
-- 3DigitalShop — Marketplace SQL (Supabase SQL Editor)
-- Execute DEPOIS do 3ds_schema.sql
-- Contém: loja pública, reviews, cliques, pesquisa, SEO
-- ============================================================

-- ── REVIEWS DE PRODUTOS ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS produto_reviews (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  produto_id  UUID NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  lojista_id  UUID NOT NULL REFERENCES lojistas(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  nome        TEXT NOT NULL DEFAULT 'Anónimo',
  email       TEXT,
  estrelas    INT NOT NULL CHECK (estrelas BETWEEN 1 AND 5),
  comentario  TEXT,
  aprovado    BOOLEAN NOT NULL DEFAULT FALSE,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE produto_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY "review_public_read" ON produto_reviews
  FOR SELECT USING (aprovado = TRUE);

CREATE POLICY "review_insert_public" ON produto_reviews
  FOR INSERT WITH CHECK (TRUE);

CREATE POLICY "review_owner_all" ON produto_reviews
  FOR ALL USING (auth.uid() = lojista_id);

-- Actualizar média de reviews no produto após insert/update
CREATE OR REPLACE FUNCTION actualizar_media_reviews()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE produtos SET
    media_reviews = (
      SELECT ROUND(AVG(estrelas::NUMERIC), 2)
      FROM produto_reviews
      WHERE produto_id = COALESCE(NEW.produto_id, OLD.produto_id)
        AND aprovado = TRUE
    ),
    total_reviews = (
      SELECT COUNT(*)
      FROM produto_reviews
      WHERE produto_id = COALESCE(NEW.produto_id, OLD.produto_id)
        AND aprovado = TRUE
    )
  WHERE id = COALESCE(NEW.produto_id, OLD.produto_id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_review_media
  AFTER INSERT OR UPDATE OR DELETE ON produto_reviews
  FOR EACH ROW EXECUTE FUNCTION actualizar_media_reviews();

-- ── CLIQUES EM PRODUTOS ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS produto_cliques (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  produto_id  UUID NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  lojista_id  UUID NOT NULL REFERENCES lojistas(id) ON DELETE CASCADE,
  ip          TEXT,
  user_agent  TEXT,
  ref         TEXT,  -- código afiliado referenciador
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE produto_cliques ENABLE ROW LEVEL SECURITY;
CREATE POLICY "clique_insert_public" ON produto_cliques FOR INSERT WITH CHECK (TRUE);
CREATE POLICY "clique_owner_read"    ON produto_cliques FOR SELECT USING (auth.uid() = lojista_id);

-- Função para registar clique e incrementar contador
CREATE OR REPLACE FUNCTION registar_clique_produto(
  p_produto_id UUID,
  p_ip         TEXT DEFAULT NULL,
  p_ua         TEXT DEFAULT NULL,
  p_ref        TEXT DEFAULT NULL
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_lojista_id UUID;
BEGIN
  SELECT lojista_id INTO v_lojista_id FROM produtos WHERE id = p_produto_id;
  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO produto_cliques (produto_id, lojista_id, ip, user_agent, ref)
  VALUES (p_produto_id, v_lojista_id, p_ip, p_ua, p_ref);

  UPDATE produtos SET total_cliques = total_cliques + 1 WHERE id = p_produto_id;
  UPDATE lojistas SET total_cliques = total_cliques + 1 WHERE id = v_lojista_id;
END;
$$;

-- Função para registar view (pageview sem clique externo)
CREATE OR REPLACE FUNCTION registar_view_produto(p_produto_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE produtos SET total_views = total_views + 1 WHERE id = p_produto_id;
END;
$$;

-- ── LISTA DE FAVORITOS (loja pública) ────────────────────────
CREATE TABLE IF NOT EXISTS favoritos (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  produto_id  UUID NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, produto_id)
);

ALTER TABLE favoritos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "favoritos_self" ON favoritos FOR ALL USING (auth.uid() = user_id);

-- ── VIEW: LOJA PÚBLICA ────────────────────────────────────────
-- Produtos activos com info da loja — usada pelo marketplace público
CREATE OR REPLACE VIEW v_marketplace_produtos AS
SELECT
  p.id,
  p.nome,
  p.descricao,
  p.preco,
  p.imagens,
  p.categoria,
  p.tags,
  p.link_externo,
  p.provedor,
  p.seo_titulo,
  p.seo_descricao,
  p.total_cliques,
  p.total_views,
  p.media_reviews,
  p.total_reviews,
  p.criado_em,
  -- Loja
  l.id           AS lojista_id,
  l.nome_loja,
  l.slug         AS loja_slug,
  l.logo_url,
  l.instagram,
  l.facebook,
  l.tiktok,
  l.youtube,
  l.website,
  -- Plano
  pl.nome        AS plano_nome
FROM produtos p
JOIN lojistas l  ON l.id  = p.lojista_id AND l.status = 'active'
JOIN planos   pl ON pl.id = l.plano_id
WHERE p.ativo = TRUE
ORDER BY p.total_cliques DESC, p.criado_em DESC;

GRANT SELECT ON v_marketplace_produtos TO anon, authenticated;

-- ── VIEW: PERFIL PÚBLICO DA LOJA ─────────────────────────────
CREATE OR REPLACE VIEW v_loja_publica AS
SELECT
  l.id,
  l.nome_loja,
  l.descricao,
  l.logo_url,
  l.banner_url,
  l.slug,
  l.instagram,
  l.facebook,
  l.tiktok,
  l.youtube,
  l.website,
  l.total_cliques,
  l.criado_em,
  pl.nome   AS plano_nome,
  COUNT(p.id) FILTER (WHERE p.ativo) AS total_produtos
FROM lojistas l
JOIN planos pl ON pl.id = l.plano_id
LEFT JOIN produtos p ON p.lojista_id = l.id
WHERE l.status = 'active'
GROUP BY l.id, pl.nome;

GRANT SELECT ON v_loja_publica TO anon, authenticated;

-- ── VIEW: PRODUTOS POR CATEGORIA ─────────────────────────────
CREATE OR REPLACE VIEW v_produtos_por_categoria AS
SELECT
  categoria,
  COUNT(*) AS total,
  ROUND(AVG(preco), 2) AS preco_medio,
  SUM(total_cliques)   AS cliques_totais
FROM produtos
WHERE ativo = TRUE
GROUP BY categoria
ORDER BY total DESC;

GRANT SELECT ON v_produtos_por_categoria TO anon, authenticated;

-- ── VIEW: TOP PRODUTOS DA SEMANA ─────────────────────────────
CREATE OR REPLACE VIEW v_top_produtos_semana AS
SELECT
  p.id,
  p.nome,
  p.preco,
  p.imagens,
  p.categoria,
  p.media_reviews,
  p.total_reviews,
  l.nome_loja,
  l.logo_url,
  COUNT(pc.id) AS cliques_semana
FROM produtos p
JOIN lojistas l ON l.id = p.lojista_id AND l.status = 'active'
LEFT JOIN produto_cliques pc
  ON pc.produto_id = p.id
  AND pc.criado_em >= NOW() - INTERVAL '7 days'
WHERE p.ativo = TRUE
GROUP BY p.id, l.nome_loja, l.logo_url
ORDER BY cliques_semana DESC, p.media_reviews DESC
LIMIT 20;

GRANT SELECT ON v_top_produtos_semana TO anon, authenticated;

-- ── VIEW: STATS ADMIN DO MARKETPLACE ─────────────────────────
CREATE OR REPLACE VIEW v_admin_marketplace_stats AS
SELECT
  (SELECT COUNT(*) FROM lojistas WHERE status = 'active')           AS lojistas_activos,
  (SELECT COUNT(*) FROM lojistas)                                    AS lojistas_total,
  (SELECT COUNT(*) FROM produtos WHERE ativo = TRUE)                 AS produtos_activos,
  (SELECT COUNT(*) FROM produtos)                                    AS produtos_total,
  (SELECT COUNT(*) FROM afiliados WHERE ativo = TRUE)                AS afiliados_activos,
  (SELECT COUNT(*) FROM pagamentos WHERE status = 'confirmed')       AS pagamentos_confirmados,
  (SELECT COALESCE(SUM(valor_ton), 0) FROM pagamentos WHERE status = 'confirmed') AS receita_ton_total,
  (SELECT COUNT(*) FROM produto_reviews WHERE aprovado = FALSE)      AS reviews_pendentes,
  (SELECT COUNT(*) FROM afiliado_saques WHERE status = 'pendente')   AS saques_pendentes;

GRANT SELECT ON v_admin_marketplace_stats TO authenticated;

-- ── PESQUISA FULL-TEXT ────────────────────────────────────────
-- Coluna de pesquisa nos produtos
ALTER TABLE produtos
  ADD COLUMN IF NOT EXISTS search_vector TSVECTOR
  GENERATED ALWAYS AS (
    setweight(to_tsvector('portuguese', COALESCE(nome, '')), 'A') ||
    setweight(to_tsvector('portuguese', COALESCE(descricao, '')), 'B') ||
    setweight(to_tsvector('portuguese', COALESCE(categoria, '')), 'C') ||
    setweight(to_tsvector('portuguese', array_to_string(tags, ' ')), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_produtos_search ON produtos USING GIN(search_vector);

-- Função de pesquisa
CREATE OR REPLACE FUNCTION pesquisar_produtos(
  p_query     TEXT,
  p_categoria TEXT DEFAULT NULL,
  p_lim       INT  DEFAULT 20,
  p_offset    INT  DEFAULT 0
)
RETURNS TABLE (
  id           UUID,
  nome         TEXT,
  descricao    TEXT,
  preco        NUMERIC,
  imagens      TEXT[],
  categoria    TEXT,
  tags         TEXT[],
  link_externo TEXT,
  provedor     TEXT,
  media_reviews NUMERIC,
  total_reviews INT,
  total_cliques INT,
  lojista_id   UUID,
  nome_loja    TEXT,
  logo_url     TEXT,
  rank         REAL
) LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id, p.nome, p.descricao, p.preco, p.imagens, p.categoria, p.tags,
    p.link_externo, p.provedor, p.media_reviews, p.total_reviews, p.total_cliques,
    l.id AS lojista_id, l.nome_loja, l.logo_url,
    ts_rank(p.search_vector, plainto_tsquery('portuguese', p_query)) AS rank
  FROM produtos p
  JOIN lojistas l ON l.id = p.lojista_id AND l.status = 'active'
  WHERE
    p.ativo = TRUE
    AND (p_query IS NULL OR p_query = '' OR p.search_vector @@ plainto_tsquery('portuguese', p_query))
    AND (p_categoria IS NULL OR p_categoria = '' OR p.categoria = p_categoria)
  ORDER BY rank DESC, p.total_cliques DESC
  LIMIT p_lim OFFSET p_offset;
END;
$$;

GRANT EXECUTE ON FUNCTION pesquisar_produtos(TEXT, TEXT, INT, INT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION registar_clique_produto(UUID, TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION registar_view_produto(UUID) TO anon, authenticated;

-- ── ÍNDICES MARKETPLACE ───────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_produtos_categoria   ON produtos(categoria) WHERE ativo = TRUE;
CREATE INDEX IF NOT EXISTS idx_produtos_cliques_desc ON produtos(total_cliques DESC) WHERE ativo = TRUE;
CREATE INDEX IF NOT EXISTS idx_produtos_reviews_desc ON produtos(media_reviews DESC) WHERE ativo = TRUE;
CREATE INDEX IF NOT EXISTS idx_reviews_produto       ON produto_reviews(produto_id) WHERE aprovado = TRUE;
CREATE INDEX IF NOT EXISTS idx_cliques_produto_data  ON produto_cliques(produto_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_favoritos_user        ON favoritos(user_id);
