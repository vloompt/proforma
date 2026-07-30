// POST /api/lead — recebe o formulário da LP e cria o contacto no GHL da Proforma.
// O token vive nas Environment Variables da Vercel (GHL_TOKEN) — nunca no browser.
const LOCATION_ID = '5CbTg6luv7phqcNzrqu9';           // sub-conta Proforma
const BASE = 'https://services.leadconnectorhq.com';   // endpoint p/ Private Integration Token

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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erro: 'método não permitido' });

  const token = process.env.GHL_TOKEN;
  if (!token) return res.status(500).json({ erro: 'GHL_TOKEN não configurado' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { nome = '', email = '', telefone = '', tipo = '' } = body;

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
      }),
    });

    const dados = await r.json().catch(() => ({}));

    // contacto duplicado devolve 400 com o id existente — para o lead isso é sucesso
    if (!r.ok && !(dados?.meta?.contactId)) {
      console.error('GHL erro', r.status, JSON.stringify(dados).slice(0, 400));
      return res.status(502).json({ erro: 'ghl', detalhe: dados?.message || r.status });
    }

    return res.status(200).json({
      ok: true,
      contactId: dados?.contact?.id || dados?.meta?.contactId || null,
      duplicado: !r.ok,
    });
  } catch (e) {
    console.error('lead handler', e);
    return res.status(500).json({ erro: 'inesperado' });
  }
}
