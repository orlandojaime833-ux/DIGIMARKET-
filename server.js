const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Config ──────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const XROCKET_API_KEY = process.env.XROCKET_API_KEY;
const ADMIN_EMAILS = ['orlandojaime833@gmail.com', 'orlandojaime800@gmail.com'];
const XROCKET_BASE = 'https://pay.ton-rocket.com';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Planos (preços base em USD) ─────────────────────────────────────────
const PLANOS = {
  standard: { usd: 9,  nome: 'Standard' },
  pro:      { usd: 25, nome: 'Pro' },
  business: { usd: 60, nome: 'Business' },
};

// ── Helper: buscar config da plataforma ────────────────────────────────
async function getConfig() {
  const { data } = await supabase.from('config_plataforma').select('*').eq('id', 1).single();
  return data || {};
}

// ── Helper: verificar admin ─────────────────────────────────────────────
function isAdmin(email) {
  return ADMIN_EMAILS.includes(email);
}

// ── Helper: autenticar token Supabase ──────────────────────────────────
async function authUser(req) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

// ════════════════════════════════════════════════════════════════════════
// PAGAMENTOS — xRocket Pay API
// ════════════════════════════════════════════════════════════════════════

// Listar moedas disponíveis na carteira xRocket
app.get('/api/currencies', async (req, res) => {
  try {
    const response = await axios.get(`${XROCKET_BASE}/currencies`, {
      headers: { 'Rocket-Pay-Key': XROCKET_API_KEY }
    });
    // Filtrar apenas moedas da rede TON com saldo > 0 ou populares
    const currencies = response.data?.data?.results || [];
    const tonCurrencies = currencies.filter(c =>
      c.available === true
    );
    res.json({ success: true, currencies: tonCurrencies });
  } catch (err) {
    console.error('Currencies error:', err.response?.data || err.message);
    // Fallback com moedas populares da rede TON
    res.json({
      success: true,
      currencies: [
        { currency: 'TONCOIN', name: 'Toncoin', minTransferAmount: 0.01 },
        { currency: 'USDT',    name: 'Tether USD', minTransferAmount: 0.01 },
        { currency: 'NOT',     name: 'Notcoin', minTransferAmount: 1 },
        { currency: 'DOGS',    name: 'DOGS', minTransferAmount: 1 },
        { currency: 'BOLT',    name: 'Bolt', minTransferAmount: 1 },
        { currency: 'SCALE',   name: 'Scaleton', minTransferAmount: 0.01 },
      ]
    });
  }
});

// Obter taxa de câmbio USD → moeda escolhida
app.get('/api/rate/:currency', async (req, res) => {
  const { currency } = req.params;
  try {
    // Tentar obter rate via xRocket trade API
    const response = await axios.get(
      `https://trade.ton-rocket.com/rates/crypto-fiat?crypto=${currency}&fiat=USD`,
      { headers: { 'Rocket-Pay-Key': XROCKET_API_KEY } }
    );
    const rate = parseFloat(response.data?.data?.rate || 0);
    if (rate > 0) {
      return res.json({ success: true, currency, usd_per_unit: rate });
    }
    throw new Error('Rate zero');
  } catch {
    // Fallback com rates aproximadas
    const fallback = {
      TONCOIN: 5.0, USDT: 1.0, NOT: 0.008,
      DOGS: 0.0005, BOLT: 0.05, SCALE: 0.15
    };
    const rate = fallback[currency] || 1.0;
    res.json({ success: true, currency, usd_per_unit: rate });
  }
});

// Criar invoice de pagamento
app.post('/api/invoice/create', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });

  const { plano, currency } = req.body;
  if (!PLANOS[plano]) return res.status(400).json({ error: 'Plano inválido' });
  if (!currency) return res.status(400).json({ error: 'Moeda obrigatória' });

  try {
    const usdAmount = PLANOS[plano].usd;

    // Obter taxa de câmbio
    const rateRes = await axios.get(
      `https://trade.ton-rocket.com/rates/crypto-fiat?crypto=${currency}&fiat=USD`,
      { headers: { 'Rocket-Pay-Key': XROCKET_API_KEY } }
    ).catch(() => null);

    const fallbackRates = {
      TONCOIN: 5.0, USDT: 1.0, NOT: 0.008,
      DOGS: 0.0005, BOLT: 0.05, SCALE: 0.15
    };
    const usdPerUnit = parseFloat(rateRes?.data?.data?.rate || fallbackRates[currency] || 1.0);
    const cryptoAmount = parseFloat((usdAmount / usdPerUnit).toFixed(6));

    // Criar invoice no xRocket
    const invoicePayload = {
      amount: cryptoAmount,
      currency: currency,
      description: `DIGIMarket — Plano ${PLANOS[plano].nome} (1 mês)`,
      hiddenMessage: `Plano ${plano} activado! Bem-vindo à DIGIMarket.`,
      payload: JSON.stringify({ userId: user.id, plano, currency }),
      callbackUrl: `${process.env.BACKEND_URL}/api/webhook/xrocket`,
    };

    const xrocketRes = await axios.post(
      `${XROCKET_BASE}/tg-invoices`,
      invoicePayload,
      { headers: { 'Rocket-Pay-Key': XROCKET_API_KEY, 'Content-Type': 'application/json' } }
    );

    const invoice = xrocketRes.data?.data;
    if (!invoice) throw new Error('Invoice não criada');

    // Guardar pagamento pendente no Supabase
    await supabase.from('pagamentos').insert({
      lojista_id: user.id,
      plano,
      valor_crypto: cryptoAmount,
      currency,
      valor_usd: usdAmount,
      invoice_id: String(invoice.id),
      invoice_link: invoice.link,
      status: 'pending',
    });

    res.json({
      success: true,
      invoice_id: invoice.id,
      invoice_link: invoice.link,
      amount: cryptoAmount,
      currency,
      usd_amount: usdAmount,
    });

  } catch (err) {
    console.error('Invoice error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erro ao criar invoice: ' + (err.response?.data?.message || err.message) });
  }
});

// Verificar estado de invoice manualmente (polling do frontend)
app.get('/api/invoice/:invoiceId/status', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });

  const { invoiceId } = req.params;

  try {
    // Verificar no xRocket
    const xrocketRes = await axios.get(
      `${XROCKET_BASE}/tg-invoices/${invoiceId}`,
      { headers: { 'Rocket-Pay-Key': XROCKET_API_KEY } }
    );

    const invoice = xrocketRes.data?.data;
    const paid = invoice?.status === 'paid';

    if (paid) {
      // Activar plano automaticamente
      await activarPlano(user.id, invoiceId);
    }

    res.json({
      success: true,
      status: invoice?.status || 'pending',
      paid,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao verificar invoice' });
  }
});

// Webhook xRocket — chamado automaticamente quando pagamento é confirmado
app.post('/api/webhook/xrocket', async (req, res) => {
  try {
    const data = req.body;
    console.log('Webhook recebido:', JSON.stringify(data));

    if (data?.type === 'invoicePaid' || data?.status === 'paid') {
      const payload = JSON.parse(data?.payload || data?.data?.payload || '{}');
      const invoiceId = String(data?.id || data?.data?.id);

      if (payload.userId && payload.plano) {
        await activarPlano(payload.userId, invoiceId);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Helper: activar plano após pagamento confirmado
async function activarPlano(userId, invoiceId) {
  const expira = new Date();
  expira.setMonth(expira.getMonth() + 1);

  // Buscar o pagamento
  const { data: pag } = await supabase
    .from('pagamentos')
    .select('*')
    .eq('invoice_id', invoiceId)
    .eq('lojista_id', userId)
    .single();

  if (!pag || pag.status === 'confirmed') return; // já processado

  const plano = pag.plano;

  // Actualizar pagamento
  await supabase.from('pagamentos')
    .update({ status: 'confirmed', confirmado_em: new Date().toISOString() })
    .eq('invoice_id', invoiceId);

  // Actualizar lojista
  const { data: lojista } = await supabase
    .from('lojistas')
    .select('id, slug')
    .eq('id', userId)
    .single();

  // Gerar slug se não tiver
  let slug = lojista?.slug;
  if (!slug) {
    slug = 'loja-' + userId.substring(0, 8);
    await supabase.from('lojistas')
      .update({ slug, plano, plano_expira_em: expira.toISOString(), status: 'active' })
      .eq('id', userId);
  } else {
    await supabase.from('lojistas')
      .update({ plano, plano_expira_em: expira.toISOString(), status: 'active' })
      .eq('id', userId);
  }

  console.log(`Plano ${plano} activado para utilizador ${userId}`);
}

// ════════════════════════════════════════════════════════════════════════
// LOJISTAS
// ════════════════════════════════════════════════════════════════════════

// Registar novo lojista (criado automaticamente após auth)
app.post('/api/lojista/setup', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });

  const { nome_loja, descricao } = req.body;
  const slug = (nome_loja || 'loja')
    .toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-')
    + '-' + user.id.substring(0, 6);

  const { error } = await supabase.from('lojistas').upsert({
    id: user.id,
    email: user.email,
    nome_loja: nome_loja || 'A Minha Loja',
    descricao: descricao || '',
    slug,
  }, { onConflict: 'id' });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, slug });
});

// Actualizar perfil da loja
app.put('/api/lojista/perfil', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });

  const campos = ['nome_loja', 'descricao', 'logo_url', 'banner_url',
                  'instagram', 'facebook', 'dominio_personalizado'];
  const update = {};
  campos.forEach(c => { if (req.body[c] !== undefined) update[c] = req.body[c]; });

  const { error } = await supabase.from('lojistas').update(update).eq('id', user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Obter dados do lojista autenticado
app.get('/api/lojista/me', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });

  const { data, error } = await supabase
    .from('lojistas').select('*').eq('id', user.id).single();

  if (error) return res.status(404).json({ error: 'Lojista não encontrado' });
  res.json({ success: true, lojista: data });
});

// ════════════════════════════════════════════════════════════════════════
// PRODUTOS
// ════════════════════════════════════════════════════════════════════════

const LIMITES_PLANO = {
  free: { prods: 5, imgs: 1 },
  standard: { prods: 30, imgs: 3 },
  pro: { prods: 100, imgs: 5 },
  business: { prods: 9999, imgs: 10 },
};

app.get('/api/produtos', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });

  const { data, error } = await supabase
    .from('produtos').select('*').eq('lojista_id', user.id).order('criado_em', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, produtos: data });
});

app.post('/api/produtos', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });

  // Verificar limite do plano
  const { data: lojista } = await supabase.from('lojistas').select('plano').eq('id', user.id).single();
  const plano = lojista?.plano || 'free';
  const limite = LIMITES_PLANO[plano];

  const { count } = await supabase.from('produtos')
    .select('*', { count: 'exact', head: true }).eq('lojista_id', user.id);

  if (count >= limite.prods) {
    return res.status(403).json({ error: `Limite de ${limite.prods} produtos atingido. Faz upgrade.` });
  }

  const { nome, descricao, preco, imagens } = req.body;
  const imgs = (imagens || []).slice(0, limite.imgs);

  const { data, error } = await supabase.from('produtos').insert({
    lojista_id: user.id, nome, descricao,
    preco: parseFloat(preco), imagens: imgs,
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, produto: data });
});

app.put('/api/produtos/:id', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });

  const { nome, descricao, preco, imagens, ativo } = req.body;
  const { error } = await supabase.from('produtos')
    .update({ nome, descricao, preco: parseFloat(preco), imagens, ativo })
    .eq('id', req.params.id).eq('lojista_id', user.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.delete('/api/produtos/:id', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });

  const { error } = await supabase.from('produtos')
    .delete().eq('id', req.params.id).eq('lojista_id', user.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════════════════
// SUB-LOJA PÚBLICA (sem auth)
// ════════════════════════════════════════════════════════════════════════

app.get('/api/store/:slug', async (req, res) => {
  const { data: loja, error } = await supabase
    .from('lojistas').select('*').eq('slug', req.params.slug).eq('status', 'active').single();

  if (error || !loja) return res.status(404).json({ error: 'Loja não encontrada' });

  const { data: produtos } = await supabase
    .from('produtos').select('*').eq('lojista_id', loja.id).eq('ativo', true);

  // Remover marca se plano Business
  if (loja.plano !== 'business') {
    loja.powered_by = 'DIGIMarket';
  }

  res.json({ success: true, loja, produtos: produtos || [] });
});

// ════════════════════════════════════════════════════════════════════════
// PAINEL ADM
// ════════════════════════════════════════════════════════════════════════

async function requireAdmin(req, res) {
  const user = await authUser(req);
  if (!user || !isAdmin(user.email)) {
    res.status(403).json({ error: 'Acesso negado' });
    return null;
  }
  return user;
}

app.get('/api/admin/lojistas', async (req, res) => {
  if (!await requireAdmin(req, res)) return;

  const { plano, status } = req.query;
  let query = supabase.from('lojistas').select('*').order('criado_em', { ascending: false });
  if (plano) query = query.eq('plano', plano);
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, lojistas: data });
});

app.put('/api/admin/lojistas/:id', async (req, res) => {
  if (!await requireAdmin(req, res)) return;

  const { status, plano } = req.body;
  const update = {};
  if (status) update.status = status;
  if (plano) update.plano = plano;

  const { error } = await supabase.from('lojistas').update(update).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.delete('/api/admin/lojistas/:id', async (req, res) => {
  if (!await requireAdmin(req, res)) return;

  // Eliminar utilizador do Supabase Auth (cascata apaga dados)
  const { error } = await supabase.auth.admin.deleteUser(req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get('/api/admin/stats', async (req, res) => {
  if (!await requireAdmin(req, res)) return;

  const { count: total } = await supabase.from('lojistas').select('*', { count: 'exact', head: true });
  const { count: ativos } = await supabase.from('lojistas').select('*', { count: 'exact', head: true }).eq('status', 'active');
  const { data: pags } = await supabase.from('pagamentos').select('valor_usd, currency, valor_crypto').eq('status', 'confirmed');

  const receitaUSD = pags?.reduce((a, p) => a + (p.valor_usd || 0), 0) || 0;

  // Distribuição por plano
  const { data: dist } = await supabase.from('lojistas').select('plano');
  const distribuicao = dist?.reduce((acc, l) => {
    acc[l.plano] = (acc[l.plano] || 0) + 1; return acc;
  }, {});

  res.json({ success: true, total, ativos, receitaUSD, distribuicao });
});

app.get('/api/admin/config', async (req, res) => {
  if (!await requireAdmin(req, res)) return;
  const config = await getConfig();
  res.json({ success: true, config });
});

app.put('/api/admin/config', async (req, res) => {
  if (!await requireAdmin(req, res)) return;

  const campos = ['ton_api_key','ton_carteira_recepcao','ton_usd_rate','taxa_transacao',
                  'preco_standard_ton','preco_pro_ton','preco_business_ton','dominio_plataforma'];
  const update = {};
  campos.forEach(c => { if (req.body[c] !== undefined) update[c] = req.body[c]; });

  const { error } = await supabase.from('config_plataforma').update(update).eq('id', 1);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── Health check ────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DIGIMarket API a correr na porta ${PORT}`));
