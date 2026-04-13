-- ============================================================
-- 3DigitalShop — Migração: Sistema de Pagamento TON Connect
-- Execute no Supabase SQL Editor após o schema principal
-- ============================================================

-- Adicionar colunas ao pagamentos
ALTER TABLE pagamentos
  ADD COLUMN IF NOT EXISTS metodo          TEXT DEFAULT 'ton_connect'
                                           CHECK (metodo IN ('ton_connect','manual','xrocket')),
  ADD COLUMN IF NOT EXISTS memo            TEXT,
  ADD COLUMN IF NOT EXISTS tx_hash         TEXT,
  ADD COLUMN IF NOT EXISTS carteira_remetente TEXT;

-- Actualizar status permitidos
ALTER TABLE pagamentos
  DROP CONSTRAINT IF EXISTS pagamentos_status_check;
ALTER TABLE pagamentos
  ADD CONSTRAINT pagamentos_status_check
  CHECK (status IN ('pending','confirmed','expired','failed','manual_review'));

-- Plano único (substituir os 6 antigos)
DELETE FROM planos WHERE id NOT IN ('pro');
INSERT INTO planos (id, nome, ton, max_produtos, max_imgs, suporte, ordem) VALUES
  ('pro', 'Profissional', 1, 50, 8, 'VIP 24/7', 1)
ON CONFLICT (id) DO UPDATE SET
  nome         = EXCLUDED.nome,
  ton          = EXCLUDED.ton,
  max_produtos = EXCLUDED.max_produtos,
  max_imgs     = EXCLUDED.max_imgs,
  suporte      = EXCLUDED.suporte,
  ativo        = TRUE;

-- Migrar lojistas com planos antigos para 'pro'
UPDATE lojistas SET plano_id = 'pro'
WHERE plano_id IN ('amador','simples','iniciante','basico','classico','profissional');

-- Índice para rastreio de transacções
CREATE INDEX IF NOT EXISTS idx_pagamentos_remetente ON pagamentos(carteira_remetente);
CREATE INDEX IF NOT EXISTS idx_pagamentos_memo       ON pagamentos(memo);
CREATE INDEX IF NOT EXISTS idx_pagamentos_pending    ON pagamentos(status, criado_em)
  WHERE status = 'pending';

-- View para admin ver pagamentos pendentes de revisão manual
CREATE OR REPLACE VIEW v_pagamentos_pendentes AS
SELECT
  p.id,
  p.lojista_id,
  l.email         AS lojista_email,
  l.nome_loja,
  p.valor_ton,
  p.metodo,
  p.memo,
  p.carteira_remetente,
  p.tx_hash,
  p.status,
  p.criado_em
FROM pagamentos p
JOIN lojistas l ON l.id = p.lojista_id
WHERE p.status IN ('pending','manual_review')
ORDER BY p.criado_em DESC;

GRANT SELECT ON v_pagamentos_pendentes TO authenticated;
