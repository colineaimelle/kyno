// api/generate-menu-chien.js
// Génère la recette d'un seul chien à la demande (bouton espace client ou ajout).
// POST authentifié (JWT Supabase), body : { chien_id }
// Enregistre recette, score_sante, score_bullets, apports, proteine_principale,
// batch_special dans la table chien. Pas de mise à jour des courses foyer
// (calculées côté client à partir des recettes individuelles).

const { getSaison, buildMultiDogMenuPrompt, ajusterRations } = require('./lib/menuGen');
const { besoinKcalJour } = require('./lib/energie');

function getEmailFromJwt(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const base64 = authHeader.slice(7).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
    return payload.email || null;
  } catch { return null; }
}

function supabaseHeaders() {
  return {
    'apikey': process.env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
  };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) throw new Error(`Supabase HTTP ${res.status}`);
  return res.json();
}

async function patchChien(chienId, fields) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/chien?id=eq.${encodeURIComponent(chienId)}`,
    {
      method: 'PATCH',
      headers: { ...supabaseHeaders(), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify(fields)
    }
  );
  if (!res.ok) {
    const e = await res.text().catch(() => '');
    console.error(`[gen-chien] PATCH chien ${chienId} (${res.status}):`, e);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const email = getEmailFromJwt(req.headers['authorization']);
  if (!email) return res.status(401).json({ error: 'Authentification requise' });

  const { chien_id } = req.body || {};
  if (!chien_id) return res.status(400).json({ error: 'chien_id manquant' });

  // Chargement et vérification d'appartenance
  const chiens = await fetchJson(
    `${process.env.SUPABASE_URL}/rest/v1/chien?user_email=eq.${encodeURIComponent(email)}&actif=eq.true&order=ordre.asc&select=*`
  );
  const chien = chiens.find(c => c.id === chien_id);
  if (!chien) return res.status(403).json({ error: 'Chien introuvable ou non autorisé' });

  const foyerRows = await fetchJson(
    `${process.env.SUPABASE_URL}/rest/v1/user?email=eq.${encodeURIComponent(email)}&select=*`
  );
  const foyer = foyerRows[0] || {};

  const saison = getSaison();
  const besoin = besoinKcalJour(chien);
  const ciblesKcal = besoin ? { [chien.id]: besoin } : {};

  const systemPrompt = buildMultiDogMenuPrompt([chien], foyer, saison, ciblesKcal);

  const menuRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Génère le menu au format JSON demandé. Uniquement le JSON, sans balises markdown.' }]
    })
  });

  if (!menuRes.ok) {
    const e = await menuRes.json().catch(() => ({}));
    return res.status(502).json({ error: e.error?.message || `Erreur Claude (${menuRes.status})` });
  }

  const result = await menuRes.json();
  let raw = result.content[0].text.trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  const fi = raw.indexOf('{'), la = raw.lastIndexOf('}');
  if (fi > 0 || la < raw.length - 1) raw = raw.slice(fi, la + 1);

  let menuData;
  try { menuData = JSON.parse(raw); }
  catch (e) { return res.status(502).json({ error: 'Parsing JSON échoué: ' + e.message }); }

  const mc = Array.isArray(menuData.chiens) && menuData.chiens[0];
  if (!mc) return res.status(502).json({ error: 'Champ chiens manquant dans la réponse Claude' });

  const adjusted = ajusterRations(menuData, { [chien.id]: chien }, ciblesKcal);
  const mcFinal = (adjusted.chiens && adjusted.chiens[0]) || mc;

  const patch = {};
  if (mcFinal.recette)                                                            patch.recette             = mcFinal.recette;
  if (mcFinal.score_sante != null)                                                patch.score_sante         = mcFinal.score_sante;
  if (Array.isArray(mcFinal.score_bullets) && mcFinal.score_bullets.length)       patch.score_bullets       = mcFinal.score_bullets.slice(0, 3);
  if (mcFinal.proteine_principale)                                                patch.proteine_principale = mcFinal.proteine_principale;
  if (Array.isArray(mcFinal.apports) && mcFinal.apports.length)                   patch.apports             = mcFinal.apports;
  if (mcFinal.batch_special)                                                      patch.batch_special       = mcFinal.batch_special;

  if (!Object.keys(patch).length) {
    return res.status(502).json({ error: 'Réponse Claude incomplète (aucun champ valide)' });
  }

  await patchChien(chien_id, patch);
  console.log(`[gen-chien] Menu généré pour ${chien.prenom_chien || chien_id} (${email})`);
  return res.status(200).json({ success: true, chien: patch });
};
