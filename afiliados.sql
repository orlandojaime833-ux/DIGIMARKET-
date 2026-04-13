-- ============================================================
-- 3DigitalShop — Afiliados SQL (Supabase SQL Editor)
-- Execute DEPOIS do 3ds_schema.sql
-- Contém: políticas avançadas, funções, views e dados de teste
-- ============================================================

-- ── FUNÇÃO: PROCESSAR COMISSÃO ───────────────────────────────
-- Chamada internamente pelo backend, mas útil como procedure SQL
CREATE OR REPLACE FUNCTION processar_comissao_afiliado(
  p_ref_codigo    TEXT,
  p_invoice_id    TEXT,
  p_lojista_id    UUID,
  p_plano_id      TEXT,
  p_valor_ton     NUMERIC
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_afiliado  afiliados%ROWTYPE;
  v_comissao  NUMERIC(14,8);
  v_existe    BOOLEAN;
BEGIN
  -- Verificar se afiliado existe e está activo
  SELECT * INTO v_afiliado
  FROM afiliados
  WHERE codigo = p_ref_codigo AND ativo = TRUE;

  IF NOT FOUND THEN RETURN; END IF;

  -- Verificar duplicado
  SELECT EXISTS(
    SELECT 1 FROM afiliado_comissoes WHERE referencia_id = p_invoice_id
  ) INTO v_existe;

  IF v_existe THEN RETURN; END IF;

  -- Calcular comissão (10%)
  v_comissao := ROUND(p_valor_ton * 0.10, 8);

  -- Inserir comissão
  INSERT INTO afiliado_comissoes (
    afiliado_id, lojista_id, plano_id,
    valor_ton, percentagem, referencia_id, status
  ) VALUES (
    v_afiliado.id, p_lojista_id, p_plano_id,
    v_comissao, 10, p_invoice_id, 'disponivel'
  );

  -- Actualizar saldo e contador
  UPDATE afiliados SET
    saldo_disponivel  = ROUND(saldo_disponivel + v_comissao, 8),
    total_conversoes  = total_conversoes + 1,
    actualizado_em    = NOW()
  WHERE id = v_afiliado.id;

END;
$$;

-- ── FUNÇÃO: EFECTUAR SAQUE (lógica em SQL puro) ──────────────
CREATE OR REPLACE FUNCTION efectuar_saque_afiliado(
  p_user_id         UUID,
  p_carteira_destino TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_afiliado  afiliados%ROWTYPE;
  v_saldo     NUMERIC(14,8);
  v_taxa      NUMERIC(14,8) := 0.01;
  v_liquido   NUMERIC(14,8);
  v_saque_id  UUID;
BEGIN
  SELECT * INTO v_afiliado FROM afiliados WHERE user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Afiliado não encontrado');
  END IF;

  v_saldo := COALESCE(v_afiliado.saldo_disponivel, 0);

  IF v_saldo <= v_taxa THEN
    RETURN jsonb_build_object('success', false, 'error', 'Saldo insuficiente');
  END IF;

  IF v_afiliado.total_conversoes = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Precisas de pelo menos 1 conversão para sacar');
  END IF;

  v_liquido := ROUND(v_saldo - v_taxa, 8);

  INSERT INTO afiliado_saques (
    afiliado_id, valor_ton, carteira_destino,
    taxa_rede, valor_liquido, status
  ) VALUES (
    v_afiliado.id, v_saldo, p_carteira_destino,
    v_taxa, v_liquido, 'pendente'
  ) RETURNING id INTO v_saque_id;

  -- Zerar saldo
  UPDATE afiliados SET
    saldo_disponivel = 0,
    saldo_pago       = ROUND(saldo_pago + v_saldo, 8),
    actualizado_em   = NOW()
  WHERE id = v_afiliado.id;

  -- Marcar comissões como pagas
  UPDATE afiliado_comissoes SET
    status  = 'pago',
    pago_em = NOW()
  WHERE afiliado_id = v_afiliado.id AND status = 'disponivel';

  RETURN jsonb_build_object(
    'success',    true,
    'saque_id',   v_saque_id,
    'valor_ton',  v_saldo,
    'valor_liquido', v_liquido
  );
END;
$$;

-- ── VIEW: RANKING DE AFILIADOS ────────────────────────────────
CREATE OR REPLACE VIEW v_ranking_afiliados AS
SELECT
  a.id,
  a.nome,
  a.codigo,
  a.total_cliques,
  a.total_conversoes,
  ROUND(a.saldo_disponivel, 4)  AS saldo_disponivel,
  ROUND(a.saldo_pago, 4)        AS saldo_pago,
  ROUND(a.saldo_disponivel + a.saldo_pago, 4) AS total_ganho,
  CASE
    WHEN a.total_cliques = 0 THEN 0
    ELSE ROUND((a.total_conversoes::NUMERIC / a.total_cliques) * 100, 2)
  END AS taxa_conversao_pct,
  a.ativo,
  a.criado_em
FROM afiliados a
ORDER BY total_ganho DESC;

-- ── VIEW: RESUMO DE SAQUES ───────────────────────────────────
CREATE OR REPLACE VIEW v_saques_resumo AS
SELECT
  s.*,
  a.email       AS afiliado_email,
  a.codigo      AS afiliado_codigo,
  a.nome        AS afiliado_nome
FROM afiliado_saques s
JOIN afiliados a ON a.id = s.afiliado_id
ORDER BY s.criado_em DESC;

-- ── VIEW: COMISSÕES DETALHADAS ───────────────────────────────
CREATE OR REPLACE VIEW v_comissoes_detalhadas AS
SELECT
  c.*,
  a.email   AS afiliado_email,
  a.codigo  AS afiliado_codigo,
  l.email   AS lojista_email,
  l.nome_loja,
  p.nome    AS plano_nome
FROM afiliado_comissoes c
LEFT JOIN afiliados a  ON a.id  = c.afiliado_id
LEFT JOIN lojistas  l  ON l.id  = c.lojista_id
LEFT JOIN planos    p  ON p.id  = c.plano_id
ORDER BY c.criado_em DESC;

-- ── VIEW: STATS DIÁRIAS DOS CLIQUES ──────────────────────────
CREATE OR REPLACE VIEW v_cliques_diarios AS
SELECT
  DATE(criado_em)  AS dia,
  COUNT(*)         AS total_cliques,
  COUNT(DISTINCT ip) AS ips_unicos
FROM afiliado_cliques
GROUP BY DATE(criado_em)
ORDER BY dia DESC;

-- ── FUNÇÃO: STATS DO AFILIADO ────────────────────────────────
CREATE OR REPLACE FUNCTION get_afiliado_stats(p_user_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_afiliado  afiliados%ROWTYPE;
  v_cliques   INT;
  v_total_ganho NUMERIC;
BEGIN
  SELECT * INTO v_afiliado FROM afiliados WHERE user_id = p_user_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT COUNT(*) INTO v_cliques
  FROM afiliado_cliques WHERE afiliado_id = v_afiliado.id;

  SELECT COALESCE(SUM(valor_ton), 0) INTO v_total_ganho
  FROM afiliado_comissoes WHERE afiliado_id = v_afiliado.id;

  RETURN jsonb_build_object(
    'id',                v_afiliado.id,
    'codigo',            v_afiliado.codigo,
    'nome',              v_afiliado.nome,
    'cliques',           v_cliques,
    'conversoes',        v_afiliado.total_conversoes,
    'saldo_disponivel',  ROUND(v_afiliado.saldo_disponivel, 6),
    'saldo_pago',        ROUND(v_afiliado.saldo_pago, 6),
    'total_ganho',       ROUND(v_total_ganho, 6),
    'taxa_conversao',    CASE WHEN v_cliques = 0 THEN 0
                              ELSE ROUND((v_afiliado.total_conversoes::NUMERIC / v_cliques) * 100, 2)
                         END
  );
END;
$$;

-- ── POLÍTICAS RLS ADICIONAIS ─────────────────────────────────

-- Afiliados: inserir próprio registo
CREATE POLICY "afiliado_insert_self" ON afiliados
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Afiliados: actualizar próprio registo
CREATE POLICY "afiliado_update_self" ON afiliados
  FOR UPDATE USING (auth.uid() = user_id);

-- Cliques: service role pode inserir (via backend)
CREATE POLICY "cliques_service_insert" ON afiliado_cliques
  FOR INSERT WITH CHECK (TRUE);

-- Comissões: service role pode inserir
CREATE POLICY "comissoes_service_insert" ON afiliado_comissoes
  FOR INSERT WITH CHECK (TRUE);

-- Saques: afiliado pode inserir o próprio
CREATE POLICY "saque_insert_self" ON afiliado_saques
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM afiliados WHERE id = afiliado_id AND user_id = auth.uid())
  );

-- ── ÍNDICES ADICIONAIS DE PERFORMANCE ────────────────────────
CREATE INDEX IF NOT EXISTS idx_cliques_data
  ON afiliado_cliques(criado_em DESC);

CREATE INDEX IF NOT EXISTS idx_comissoes_status
  ON afiliado_comissoes(status);

CREATE INDEX IF NOT EXISTS idx_comissoes_referencia
  ON afiliado_comissoes(referencia_id);

CREATE INDEX IF NOT EXISTS idx_saques_status
  ON afiliado_saques(status);

-- ── GRANT para anon/service ───────────────────────────────────
GRANT SELECT ON v_ranking_afiliados   TO anon, authenticated;
GRANT SELECT ON v_saques_resumo       TO authenticated;
GRANT SELECT ON v_comissoes_detalhadas TO authenticated;
GRANT EXECUTE ON FUNCTION incrementar_cliques(UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_afiliado_stats(UUID)  TO authenticated;
