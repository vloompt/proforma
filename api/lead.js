// POST /api/lead — recebe o formulário da LP, cria o contacto no GHL da Proforma
// e envia o evento Lead ao Meta pela Conversions API (server-side, deduplicado).
// Tokens vivem nas Environment Variables da Vercel — nunca no browser.
import crypto from 'crypto';

const LOCATION_ID = '5CbTg6luv7phqcNzrqu9';            // sub-conta Proforma
const CF_TIPO = 'vcWVGDxHMHcThHlHH7Fg';                // custom field 'Tipo de entidade (LP)'
const BASE = 'https://services.leadconnectorhq.com';   // endpoint p/ Private Integration Token
const PIXEL_ID = '25693688203628804';                  // pixel "ProformaSite"
const CAPI_URL = `https://graph.facebook.com/v21.0/${PIXEL_ID}/events`;

const TAG_POR_TIPO = {
  'Centro de formação profissional': 'entidade-centro-formacao',
  'Entidade formadora certificada DGERT': 'entidade-dgert',
  'Escola de condução / formação rodoviária': 'entidade-escola-conducao',
  'Departamento de formação de uma empresa': 'entidade-departamento-formacao',
  'Ainda em processo de certificação': 'entidade-por-certificar',
};

function partirNome(nome = '') {
  const p = String(nome).trim().split(/\s+/);
  return { firstName: p[0] || '', lastName: p.slice(1).join(' ') || '' };
}

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

// normaliza + hasheia segundo as regras do Meta (minúsculas, sem espaços; telefone só dígitos com indicativo)
function hashEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return e ? [sha256(e)] : undefined;
}
function hashTelefone(tel) {
  let d = String(tel || '').replace(/\D/g, '');
  if (!d) return undefined;
  if (d.length === 9 && d[0] === '9') d = '351' + d;   // PT: 9XXXXXXXX -> 3519XXXXXXXX
  return [sha256(d)];
}
function hashNome(v) {
  const s = String(v || '').trim().toLowerCase();
  return s ? [sha256(s)] : undefined;
}

// envia o evento Lead ao Meta pela CAPI; nunca lança — só regista
async function enviarCAPI({ email, telefone, firstName, lastName, tipo, eventId, fbp, fbc, ip, ua, sourceUrl }) {
  const token = process.env.META_CAPI_TOKEN;
  if (!token) return { skipped: 'sem META_CAPI_TOKEN' };

  const user_data = {
    em: hashEmail(email),
    ph: hashTelefone(telefone),
    fn: hashNome(firstName),
    ln: hashNome(lastName),
    fbp: fbp || undefined,
    fbc: fbc || undefined,
    client_ip_address: ip || undefined,
    client_user_agent: ua || undefined,
  };
  Object.keys(user_data).forEach((k) => user_data[k] === undefined && delete user_data[k]);

  const payload = {
    data: [{
      event_name: 'Lead',
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId || undefined,             // dedup com o pixel do browser
      action_source: 'website',
      event_source_url: sourceUrl || undefined,
      user_data,
      custom_data: { content_name: 'LP Teste Grátis', tipo: tipo || undefined },
    }],
  };

  try {
    const r = await fetch(`${CAPI_URL}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { console.error('CAPI erro', r.status, JSON.stringify(d).slice(0, 300)); return { ok: false }; }
    return { ok: true, received: d?.events_received };
  } catch (e) {
    console.error('CAPI exceção', e.message);
    return { ok: false };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'método não permitido' });

  const token = process.env.GHL_TOKEN;
  if (!token) return res.status(500).json({ erro: 'GHL_TOKEN não configurado' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const {
      nome = '', email = '', telefone = '', tipo = '',
      eventId = '', fbp = '', fbc = '', fbclid = '', eventSourceUrl = '',
    } = body;

    if (!email && !telefone) return res.status(400).json({ erro: 'faltam contactos' });

    const { firstName, lastName } = partirNome(nome);
    const tags = ['lp-teste-gratis'];
    if (TAG_POR_TIPO[tipo]) tags.push(TAG_POR_TIPO[tipo]);

    const r = await fetch(`${BASE}/contacts/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Version: '2021-07-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        locationId: LOCATION_ID,
        firstName, lastName,
        email: email || undefined,
        phone: telefone || undefined,
        tags,
        source: 'LP Teste Grátis',
        customFields: tipo ? [{ id: CF_TIPO, value: tipo }] : undefined,
      }),
    });

    const dados = await r.json().catch(() => ({}));

    // contacto duplicado devolve 400 com o id existente — para o lead isso é sucesso
    if (!r.ok && !(dados?.meta?.contactId)) {
      console.error('GHL erro', r.status, JSON.stringify(dados).slice(0, 400));
      return res.status(502).json({ erro: 'ghl', detalhe: dados?.message || r.status });
    }

    // Conversions API — evento Lead server-side (deduplicado com o pixel pelo eventId).
    // fbc: usa o enviado; se faltar mas houver fbclid, constrói-o no formato do Meta.
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress;
    const ua = req.headers['user-agent'] || '';
    const fbcFinal = fbc || (fbclid ? `fb.1.${Date.now()}.${fbclid}` : '');
    const capi = await enviarCAPI({
      email, telefone, firstName, lastName, tipo,
      eventId, fbp, fbc: fbcFinal, ip, ua, sourceUrl: eventSourceUrl,
    });

    return res.status(200).json({
      ok: true,
      contactId: dados?.contact?.id || dados?.meta?.contactId || null,
      duplicado: !r.ok,
      capi,
    });
  } catch (e) {
    console.error('lead handler', e);
    return res.status(500).json({ erro: 'inesperado' });
  }
}
