const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const crypto = require('crypto');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const XROCKET_API_KEY = process.env.XROCKET_API_KEY || '2b95ea2ad1f9a2d53563a05d4';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyCtgYlBixQ0YFzOIujh6rkqUqjbV8t2Xw8';
const BACKEND_URL = process.env.BACKEND_URL || 'https://digimarket-h0vk.onrender.com';
const FRONTEND_URL = 'https://orlandojaime833-ux.github.io/DIGIMARKET-';
const ADMIN_EMAILS = ['orlandojaime833@gmail.com', 'orlandojaime800@gmail.com'];
const XROCKET_BASE = 'https://pay.ton-rocket.com';
const COMISSAO_AFILIADO = 0.10;
const TAXA_REDE = 0.01;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

function getModel() {
  return genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
}

function converterHist(h) {
  return (h || []).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
}

async function authUser(req) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  return (error || !user) ? null : user;
}

async function requireAdmin(req, res) {
  const user = await authUser(req);
  if (!user || !ADMIN_EMAILS.includes(user.email)) { res.status(403).json({ error: 'Acesso negado' }); return null; }
  return user;
}

async function getTonRate(currency = 'TONCOIN') {
  try {
    const r = await axios.get(`https://trade.ton-rocket.com/rates/crypto-fiat?crypto=${currency}&fiat=USD`, { headers: { 'Rocket-Pay-Key': XROCKET_API_KEY } });
    return parseFloat(r.data?.data?.rate || 5);
  } catch { return 5; }
}

async function getConfig() {
  const { data } = await supabase.from('config_plataforma').select('*').eq('id', 1).single();
  return data || {};
}

// ── Links mascarados ──
app.get('/loja/:codigo', async (req, res) => {
  try {
    const { data: lj } = await supabase.from('lojistas').select('slug,status').eq('link_mascarado', req.params.codigo).single();
    if (!lj || lj.status !== 'active') return res.redirect(FRONTEND_URL);
    res.redirect(`${FRONTEND_URL}/loja/${lj.slug}`);
  } catch { res.redirect(FRONTEND_URL); }
});

app.get('/r/:codigo', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').substring(0, 45);
  const ua = (req.headers['user-agent'] || '').substring(0, 200);
  try {
    const { data: af } = await supabase.from('afiliados').select('id,codigo,ativo').eq('codigo', req.params.codigo).single();
    if (!af || !af.ativo) return res.redirect(FRONTEND_URL);
    await supabase.from('afiliado_cliques').insert({ afiliado_id: af.id, ip, user_agent: ua });
    await supabase.rpc('incrementar_cliques', { afiliado_id: af.id });
    res.setHeader('Set-Cookie', `ref=${af.codigo}; Path=/; Max-Age=2592000; SameSite=None; Secure`);
    res.redirect(`${FRONTEND_URL}?ref=${af.codigo}`);
  } catch { res.redirect(FRONTEND_URL); }
});

// ── GEMINI AI ──
async function geminiChat(systemPrompt, historico, mensagem) {
  const model = getModel();
  const hist = converterHist(historico);
  const chat = model.startChat({
    history: [
      { role: 'user', parts: [{ text: systemPrompt }] },
      { role: 'model', parts: [{ text: 'Entendido! Pronto para ajudar.' }] },
      ...hist,
    ],
  });
  const result = await chat.sendMessage(mensagem);
  return result.response.text();
}

app.post('/api/ai/lojista', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  const { mensagem, historico } = req.body;
  const { data: lj } = await supabase.from('lojistas').select('nome_loja,plano_id').eq('id', user.id).single();
  const { data: prods } = await supabase.from('produtos').select('nome').eq('lojista_id', user.id).limit(10);
  const sys = `És o assistente IA da 3DigitalShop. Ajudas o lojista "${lj?.nome_loja}" (plano: ${lj?.plano_id}). Produtos: ${prods?.map(p=>p.nome).join(', ')||'nenhum'}. Capacidades: descrições SEO, posts redes sociais, estratégias marketing, analytics, emails, optimizar tags. Responde em português, prático e directo.`;
  try {
    const resposta = await geminiChat(sys, historico, mensagem);
    await supabase.from('ai_conversas').upsert({ user_id: user.id, lojista_id: user.id, contexto: 'lojista', mensagens: [...(historico||[]), {role:'user',content:mensagem}, {role:'assistant',content:resposta}], actualizado_em: new Date().toISOString() }, { onConflict: 'user_id,contexto' });
    res.json({ success: true, resposta });
  } catch (err) { res.status(500).json({ error: 'Erro Gemini: ' + err.message }); }
});

app.post('/api/ai/afiliado', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  const { mensagem, historico } = req.body;
  const { data: af } = await supabase.from('afiliados').select('nome,codigo,total_cliques,total_conversoes').eq('user_id', user.id).single();
  const sys = `És o assistente VIP de marketing da 3DigitalShop. Afiliado: "${af?.nome}" (código: ${af?.codigo}, cliques: ${af?.total_cliques||0}, conversões: ${af?.total_conversoes||0}). Especializado em: posts virais Instagram/Facebook/TikTok, scripts YouTube, email marketing, copywriting, funis de vendas. Planos: Amador 0.5 TON, Simples 1.5 TON, Iniciante 3 TON, Básico 5 TON, Clássico 8 TON, Profissional 10 TON. Comissão: 10% por plano. Responde em português com conteúdo pronto a usar.`;
  try {
    const resposta = await geminiChat(sys, historico, mensagem);
    await supabase.from('ai_conversas').upsert({ user_id: user.id, lojista_id: null, contexto: 'afiliado', mensagens: [...(historico||[]), {role:'user',content:mensagem}, {role:'assistant',content:resposta}], actualizado_em: new Date().toISOString() }, { onConflict: 'user_id,contexto' });
    res.json({ success: true, resposta });
  } catch (err) { res.status(500).json({ error: 'Erro Gemini: ' + err.message }); }
});

app.post('/api/ai/descricao', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  const { nome, categoria, preco } = req.body;
  try {
    const model = getModel();
    const result = await model.generateContent(`Cria descrição de produto digital optimizada para SEO. Produto: "${nome}", Categoria: ${categoria||'digital'}, Preço: $${preco||'N/A'}. Responde APENAS JSON válido sem markdown: {"descricao":"texto 2-3 parágrafos em português","seo_titulo":"max 60 chars","seo_descricao":"max 160 chars","tags_sugeridas":["t1","t2","t3","t4","t5"]}`);
    const clean = result.response.text().replace(/```json|```/g,'').trim();
    res.json({ success: true, ...JSON.parse(clean) });
  } catch (err) { res.status(500).json({ error: 'Erro IA: ' + err.message }); }
});

app.post('/api/ai/admin', async (req, res) => {
  if (!await requireAdmin(req, res)) return;
  const { mensagem, historico } = req.body;
  const { count: lojistas } = await supabase.from('lojistas').select('*', { count:'exact', head:true });
  const { count: afiliados } = await supabase.from('afiliados').select('*', { count:'exact', head:true });
  const sys = `És o assistente de gestão da 3DigitalShop. Stats: ${lojistas} lojistas, ${afiliados} afiliados. Ajudas com análise, estratégias, relatórios. Responde em português.`;
  try {
    const resposta = await geminiChat(sys, historico, mensagem);
    res.json({ success: true, resposta });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/ai/historico/:contexto', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  const { data } = await supabase.from('ai_conversas').select('mensagens').eq('user_id', user.id).eq('contexto', req.params.contexto).single();
  res.json({ success: true, mensagens: data?.mensagens || [] });
});

// ── PLANOS ──
app.get('/api/planos', async (req, res) => {
  const { data, error } = await supabase.from('planos').select('*').eq('ativo', true).order('ordem');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, planos: data });
});

// ── PAGAMENTOS ──
app.get('/api/currencies', async (req, res) => {
  try {
    const r = await axios.get(`${XROCKET_BASE}/currencies`, { headers: { 'Rocket-Pay-Key': XROCKET_API_KEY } });
    res.json({ success: true, currencies: (r.data?.data?.results||[]).filter(c=>c.available) });
  } catch { res.json({ success: true, currencies: [{currency:'TONCOIN',name:'Toncoin'},{currency:'USDT',name:'Tether USD'},{currency:'NOT',name:'Notcoin'},{currency:'DOGS',name:'DOGS'}] }); }
});

app.get('/api/rate/:currency', async (req, res) => {
  res.json({ success: true, currency: req.params.currency, usd_per_unit: await getTonRate(req.params.currency) });
});

app.post('/api/invoice/criar', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  const { plano_id, currency, ref_afiliado } = req.body;
  const { data: plano } = await supabase.from('planos').select('*').eq('id', plano_id).single();
  if (!plano) return res.status(404).json({ error: 'Plano não encontrado' });
  try {
    const cur = currency || 'TONCOIN';
    let amount = plano.ton;
    if (cur !== 'TONCOIN') { const r = await getTonRate('TONCOIN'); amount = parseFloat(((plano.ton * r) / await getTonRate(cur)).toFixed(6)); }
    const xRes = await axios.post(`${XROCKET_BASE}/tg-invoices`, {
      amount, currency: cur,
      description: `3DigitalShop — Plano ${plano.nome} (1 mês)`,
      hiddenMessage: `Plano ${plano.nome} activado!`,
      payload: JSON.stringify({ userId: user.id, plano_id, currency: cur, ref_afiliado: ref_afiliado || null }),
      callbackUrl: `${BACKEND_URL}/api/webhook/pagamento`,
    }, { headers: { 'Rocket-Pay-Key': XROCKET_API_KEY, 'Content-Type': 'application/json' } });
    const invoice = xRes.data?.data;
    if (!invoice) throw new Error('Invoice não criada');
    await supabase.from('pagamentos').insert({ lojista_id: user.id, plano_id, valor_ton: plano.ton, currency: cur, invoice_id: String(invoice.id), invoice_link: invoice.link, status: 'pending', ref_afiliado: ref_afiliado || null });
    res.json({ success: true, invoice_id: invoice.id, invoice_link: invoice.link, amount, currency: cur });
  } catch (err) { res.status(500).json({ error: err.response?.data?.message || err.message }); }
});

app.get('/api/invoice/:id/status', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  try {
    const xRes = await axios.get(`${XROCKET_BASE}/tg-invoices/${req.params.id}`, { headers: { 'Rocket-Pay-Key': XROCKET_API_KEY } });
    const paid = xRes.data?.data?.status === 'paid';
    if (paid) { const { data: pag } = await supabase.from('pagamentos').select('*').eq('invoice_id', req.params.id).single(); if (pag && pag.status !== 'confirmed') await activarPlano(user.id, req.params.id, pag.ref_afiliado); }
    res.json({ success: true, paid, status: xRes.data?.data?.status });
  } catch { res.status(500).json({ error: 'Erro ao verificar' }); }
});

app.post('/api/webhook/pagamento', async (req, res) => {
  try {
    const data = req.body;
    if (data?.type === 'invoicePaid' || data?.status === 'paid') {
      const payload = JSON.parse(data?.payload || data?.data?.payload || '{}');
      const invoiceId = String(data?.id || data?.data?.id);
      if (payload.userId && payload.plano_id) await activarPlano(payload.userId, invoiceId, payload.ref_afiliado);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function activarPlano(userId, invoiceId, refAfiliado) {
  const expira = new Date(); expira.setMonth(expira.getMonth() + 1);
  const { data: pag } = await supabase.from('pagamentos').select('*').eq('invoice_id', invoiceId).single();
  if (!pag || pag.status === 'confirmed') return;
  await supabase.from('pagamentos').update({ status: 'confirmed', confirmado_em: new Date().toISOString() }).eq('invoice_id', invoiceId);
  const linkMascarado = crypto.randomBytes(5).toString('hex').toUpperCase();
  const { data: lj } = await supabase.from('lojistas').select('link_mascarado').eq('id', userId).single();
  await supabase.from('lojistas').update({ plano_id: pag.plano_id, plano_expira_em: expira.toISOString(), status: 'active', link_mascarado: lj?.link_mascarado || linkMascarado }).eq('id', userId);
  if (refAfiliado) await processarComissao(refAfiliado, invoiceId, userId, pag.plano_id, pag.valor_ton);
}

async function processarComissao(refCodigo, invoiceId, lojistaId, planoId, valorTon) {
  try {
    const { data: af } = await supabase.from('afiliados').select('*').eq('codigo', refCodigo).eq('ativo', true).single();
    if (!af) return;
    const { data: ex } = await supabase.from('afiliado_comissoes').select('id').eq('referencia_id', invoiceId).single();
    if (ex) return;
    const comissao = parseFloat((valorTon * COMISSAO_AFILIADO).toFixed(8));
    await supabase.from('afiliado_comissoes').insert({ afiliado_id: af.id, lojista_id: lojistaId, plano_id: planoId, valor_ton: comissao, percentagem: 10, referencia_id: invoiceId, status: 'disponivel' });
    await supabase.from('afiliados').update({ saldo_disponivel: parseFloat(((af.saldo_disponivel||0)+comissao).toFixed(8)), total_conversoes: (af.total_conversoes||0)+1 }).eq('id', af.id);
  } catch (e) { console.error('Comissão erro:', e.message); }
}

// ── LOJISTAS ──
app.get('/api/lojista/me', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  const { data, error } = await supabase.from('lojistas').select('*, planos(*)').eq('id', user.id).single();
  if (error) return res.status(404).json({ error: 'Não encontrado' });
  if (data.link_mascarado) data.link_url = `${BACKEND_URL}/loja/${data.link_mascarado}`;
  res.json({ success: true, lojista: data });
});

app.put('/api/lojista/perfil', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  const campos = ['nome_loja','descricao','logo_url','banner_url','instagram','facebook','tiktok','youtube','website'];
  const update = {}; campos.forEach(c => { if (req.body[c] !== undefined) update[c] = req.body[c]; });
  const { error } = await supabase.from('lojistas').update(update).eq('id', user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get('/api/lojista/analytics', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  const { data: prods } = await supabase.from('produtos').select('nome,total_cliques,total_views,media_reviews,preco').eq('lojista_id', user.id).order('total_cliques', { ascending: false });
  const { data: lj } = await supabase.from('lojistas').select('total_cliques,plano_id,plano_expira_em').eq('id', user.id).single();
  res.json({ success: true, loja_cliques: lj?.total_cliques||0, total_cliques: prods?.reduce((a,p)=>a+(p.total_cliques||0),0)||0, total_views: prods?.reduce((a,p)=>a+(p.total_views||0),0)||0, produtos: prods||[], plano: lj?.plano_id, expira: lj?.plano_expira_em });
});

// ── PRODUTOS ──
app.get('/api/produtos', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  const { data, error } = await supabase.from('produtos').select('*').eq('lojista_id', user.id).order('criado_em', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, produtos: data });
});

app.post('/api/produtos', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  const { data: lj } = await supabase.from('lojistas').select('plano_id, planos(max_produtos,max_imgs)').eq('id', user.id).single();
  const maxProds = lj?.planos?.max_produtos || 1;
  const { count } = await supabase.from('produtos').select('*', { count:'exact', head:true }).eq('lojista_id', user.id);
  if (count >= maxProds) return res.status(403).json({ error: `Limite de ${maxProds} produtos atingido. Faz upgrade.` });
  if (!req.body.link_externo) return res.status(400).json({ error: 'Link externo obrigatório' });
  const { data, error } = await supabase.from('produtos').insert({ lojista_id: user.id, nome: req.body.nome, descricao: req.body.descricao, preco: req.body.preco ? parseFloat(req.body.preco) : null, imagens: (req.body.imagens||[]).slice(0, lj?.planos?.max_imgs||2), categoria: req.body.categoria, tags: req.body.tags||[], link_externo: req.body.link_externo, provedor: req.body.provedor||null }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, produto: data });
});

app.put('/api/produtos/:id', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  const campos = ['nome','descricao','preco','imagens','categoria','tags','link_externo','provedor','seo_titulo','seo_descricao','ativo'];
  const update = {}; campos.forEach(c => { if (req.body[c] !== undefined) update[c] = req.body[c]; });
  const { error } = await supabase.from('produtos').update(update).eq('id', req.params.id).eq('lojista_id', user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.delete('/api/produtos/:id', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  await supabase.from('produtos').delete().eq('id', req.params.id).eq('lojista_id', user.id);
  res.json({ success: true });
});

// ── AUTOMAÇÕES ──
const AUTOS = [
  {tipo:'resposta_automatica',nome:'Resposta automática a mensagens'},
  {tipo:'email_boas_vindas',nome:'Email de boas-vindas'},
  {tipo:'followup_pos_compra',nome:'Follow-up pós-compra'},
  {tipo:'recuperar_carrinho',nome:'Recuperação de carrinho'},
  {tipo:'promocao_aniversario',nome:'Promoção de aniversário'},
  {tipo:'publicacao_redes',nome:'Publicação em redes sociais'},
  {tipo:'descricao_ia',nome:'Geração de descrição por IA (Gemini)'},
  {tipo:'seo_automatico',nome:'SEO automático'},
  {tipo:'newsletter_semanal',nome:'Newsletter semanal'},
  {tipo:'alerta_produto_popular',nome:'Alerta de produto popular'},
  {tipo:'cupao_reactivacao',nome:'Cupão de reactivação'},
  {tipo:'relatorio_semanal',nome:'Relatório semanal automático'},
  {tipo:'resposta_reviews',nome:'Resposta automática a reviews'},
  {tipo:'agendar_promocoes',nome:'Agendamento de promoções'},
  {tipo:'verificar_links',nome:'Verificação de links externos'},
];

app.get('/api/automacoes', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  const { data } = await supabase.from('automacoes').select('*').eq('lojista_id', user.id);
  const activas = data || [];
  res.json({ success: true, automacoes: AUTOS.map(a => ({ ...a, ativa: activas.find(x=>x.tipo===a.tipo)?.ativa||false })) });
});

app.put('/api/automacoes/:tipo', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  const a = AUTOS.find(x=>x.tipo===req.params.tipo);
  if (!a) return res.status(404).json({ error: 'Não encontrada' });
  await supabase.from('automacoes').upsert({ lojista_id: user.id, tipo: req.params.tipo, nome: a.nome, ativa: req.body.ativa!==undefined?req.body.ativa:true, config: req.body.config||{} }, { onConflict: 'lojista_id,tipo' });
  res.json({ success: true });
});

// ── AFILIADOS ──
app.post('/api/afiliado/registar', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  const { data: ex } = await supabase.from('afiliados').select('id,codigo').eq('user_id', user.id).single();
  if (ex) return res.json({ success: true, already: true, link: `${BACKEND_URL}/r/${ex.codigo}` });
  const codigo = Math.random().toString(36).substring(2,10).toUpperCase();
  const { data, error } = await supabase.from('afiliados').insert({ user_id: user.id, email: user.email, nome: req.body.nome||user.email.split('@')[0], codigo, carteira_ton: req.body.carteira_ton||null, ativo: true }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, afiliado: data, link: `${BACKEND_URL}/r/${codigo}` });
});

app.get('/api/afiliado/me', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  const { data: af } = await supabase.from('afiliados').select('*').eq('user_id', user.id).single();
  if (!af) return res.status(404).json({ error: 'Não és afiliado' });
  const { count: cliques } = await supabase.from('afiliado_cliques').select('*',{count:'exact',head:true}).eq('afiliado_id', af.id);
  const { data: comissoes } = await supabase.from('afiliado_comissoes').select('*').eq('afiliado_id', af.id).order('criado_em',{ascending:false});
  const { data: saques } = await supabase.from('afiliado_saques').select('*').eq('afiliado_id', af.id).order('criado_em',{ascending:false});
  res.json({ success: true, afiliado: af, link: `${BACKEND_URL}/r/${af.codigo}`, stats: { cliques: cliques||0, conversoes: af.total_conversoes||0, saldo_disponivel: parseFloat((af.saldo_disponivel||0).toFixed(6)), saldo_pago: parseFloat((af.saldo_pago||0).toFixed(6)), total_ganho: parseFloat((comissoes||[]).reduce((a,c)=>a+c.valor_ton,0).toFixed(6)) }, comissoes: comissoes||[], saques: saques||[] });
});

app.put('/api/afiliado/perfil', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  await supabase.from('afiliados').update({ carteira_ton: req.body.carteira_ton, nome: req.body.nome }).eq('user_id', user.id);
  res.json({ success: true });
});

app.post('/api/afiliado/saque', async (req, res) => {
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });
  const { carteira_destino } = req.body;
  if (!carteira_destino) return res.status(400).json({ error: 'Carteira obrigatória' });
  const { data: af } = await supabase.from('afiliados').select('*').eq('user_id', user.id).single();
  if (!af) return res.status(404).json({ error: 'Não encontrado' });
  const saldo = parseFloat(af.saldo_disponivel||0);
  if (saldo <= TAXA_REDE) return res.status(400).json({ error: 'Saldo insuficiente' });
  if (!af.total_conversoes) return res.status(400).json({ error: 'Precisas de pelo menos 1 conversão para sacar' });
  const liquido = parseFloat((saldo - TAXA_REDE).toFixed(8));
  try {
    const { data: saque } = await supabase.from('afiliado_saques').insert({ afiliado_id: af.id, valor_ton: saldo, carteira_destino, taxa_rede: TAXA_REDE, valor_liquido: liquido, status: 'processando' }).select().single();
    let txHash = null;
    try {
      const xRes = await axios.post(`${XROCKET_BASE}/withdrawal`, { network:'TON', currency:'TONCOIN', amount: liquido, address: carteira_destino, comment: `3DigitalShop Afiliado #${af.codigo}` }, { headers: {'Rocket-Pay-Key':XROCKET_API_KEY,'Content-Type':'application/json'} });
      txHash = xRes.data?.data?.txHash||null;
    } catch {
      await supabase.from('afiliado_saques').update({ status: 'pendente' }).eq('id', saque.id);
      return res.json({ success: true, manual: true, message: 'Saque registado. Processado em até 24h.' });
    }
    await supabase.from('afiliado_saques').update({ status:'pago', tx_hash:txHash, processado_em:new Date().toISOString() }).eq('id', saque.id);
    await supabase.from('afiliados').update({ saldo_disponivel:0, saldo_pago:parseFloat(((af.saldo_pago||0)+saldo).toFixed(8)) }).eq('id', af.id);
    await supabase.from('afiliado_comissoes').update({ status:'pago', pago_em:new Date().toISOString() }).eq('afiliado_id', af.id).eq('status','disponivel');
    res.json({ success: true, tx_hash: txHash, valor_liquido: liquido });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN ──
app.get('/api/admin/stats', async (req, res) => {
  if (!await requireAdmin(req,res)) return;
  const { count: total } = await supabase.from('lojistas').select('*',{count:'exact',head:true});
  const { count: ativos } = await supabase.from('lojistas').select('*',{count:'exact',head:true}).eq('status','active');
  const { count: afiliados } = await supabase.from('afiliados').select('*',{count:'exact',head:true}).eq('ativo',true);
  const { data: pags } = await supabase.from('pagamentos').select('valor_ton').eq('status','confirmed');
  const { data: dist } = await supabase.from('lojistas').select('plano_id');
  const receita = pags?.reduce((a,p)=>a+(p.valor_ton||0),0)||0;
  const distribuicao = dist?.reduce((acc,l)=>{acc[l.plano_id]=(acc[l.plano_id]||0)+1;return acc;},{});
  res.json({ success:true, total, ativos, afiliados, receita_ton:parseFloat(receita.toFixed(4)), distribuicao });
});

app.get('/api/admin/lojistas', async (req, res) => {
  if (!await requireAdmin(req,res)) return;
  let q = supabase.from('lojistas').select('*,planos(nome,ton)').order('criado_em',{ascending:false});
  if (req.query.plano) q=q.eq('plano_id',req.query.plano);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success:true, lojistas:data });
});

app.put('/api/admin/lojistas/:id', async (req, res) => {
  if (!await requireAdmin(req,res)) return;
  const update={};
  if (req.body.status) update.status=req.body.status;
  if (req.body.plano_id) update.plano_id=req.body.plano_id;
  await supabase.from('lojistas').update(update).eq('id',req.params.id);
  res.json({ success:true });
});

app.delete('/api/admin/lojistas/:id', async (req, res) => {
  if (!await requireAdmin(req,res)) return;
  await supabase.auth.admin.deleteUser(req.params.id);
  res.json({ success:true });
});

app.get('/api/admin/afiliados', async (req, res) => {
  if (!await requireAdmin(req,res)) return;
  const { data } = await supabase.from('afiliados').select('*').order('criado_em',{ascending:false});
  res.json({ success:true, afiliados:data||[] });
});

app.get('/api/admin/saques', async (req, res) => {
  if (!await requireAdmin(req,res)) return;
  const { data } = await supabase.from('afiliado_saques').select('*,afiliados(email,codigo)').order('criado_em',{ascending:false});
  res.json({ success:true, saques:data||[] });
});

app.put('/api/admin/saques/:id', async (req, res) => {
  if (!await requireAdmin(req,res)) return;
  const { status, tx_hash } = req.body;
  await supabase.from('afiliado_saques').update({ status, tx_hash, processado_em:new Date().toISOString() }).eq('id',req.params.id);
  if (status==='pago') {
    const { data:saque } = await supabase.from('afiliado_saques').select('*').eq('id',req.params.id).single();
    if (saque) {
      const { data:af } = await supabase.from('afiliados').select('*').eq('id',saque.afiliado_id).single();
      if (af) {
        await supabase.from('afiliados').update({ saldo_disponivel:0, saldo_pago:parseFloat(((af.saldo_pago||0)+saque.valor_ton).toFixed(8)) }).eq('id',af.id);
        await supabase.from('afiliado_comissoes').update({ status:'pago', pago_em:new Date().toISOString() }).eq('afiliado_id',af.id).eq('status','disponivel');
      }
    }
  }
  res.json({ success:true });
});

app.get('/api/admin/config', async (req, res) => {
  if (!await requireAdmin(req,res)) return;
  res.json({ success:true, config: await getConfig() });
});

app.put('/api/admin/config', async (req, res) => {
  if (!await requireAdmin(req,res)) return;
  const campos=['xrocket_api_key','ton_usd_rate','comissao_afiliado','taxa_rede_ton','gemini_api_key','dominio_plataforma','nome_plataforma'];
  const update={}; campos.forEach(c=>{if(req.body[c]!==undefined)update[c]=req.body[c];});
  await supabase.from('config_plataforma').update(update).eq('id',1);
  res.json({ success:true });
});

app.get('/health', (_,res) => res.json({ status:'ok', service:'3DigitalShop', ai:'Gemini 1.5 Flash', timestamp:new Date() }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`3DigitalShop API (Gemini AI) na porta ${PORT}`));
