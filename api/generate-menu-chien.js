// api/generate-menu-chien.js
// Génère la recette d'un seul chien à la demande (bouton espace client ou ajout).
// POST authentifié (JWT Supabase), body : { chien_id }
// Enregistre recette, score_sante, score_bullets, apports, proteine_principale,
// batch_special, derniere_generation dans la table chien.
// Requiert la migration : ALTER TABLE chien ADD COLUMN IF NOT EXISTS derniere_generation date;

const { getSaison, buildMultiDogMenuPrompt, ajusterRations } = require('./lib/menuGen');
const { besoinKcalJour } = require('./lib/energie');

// Identique à chat.js — décode l'email depuis le JWT Supabase sans fallback body.
function getEmailFromJwt(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
    return payload.email || null;
  } catch {
    return null;
  }
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

// Identique à chat.js — vérifie l'appartenance en base avec id ET user_email.
async function verifyChienOwnership(chienId, email) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/chien?id=eq.${encodeURIComponent(chienId)}&user_email=eq.${encodeURIComponent(email)}&actif=eq.true&select=*&limit=1`,
    { headers: supabaseHeaders() }
  );
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return rows.length > 0 ? rows[0] : null;
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
    throw new Error(`PATCH chien échoué (${res.status})`);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  // ── 1. Authentification JWT ───────────────────────────────────────────────
  const email = getEmailFromJwt(req.headers['authorization']);
  if (!email) return res.status(401).json({ error: 'Authentification requise' });

  const { chien_id } = req.body || {};
  if (!chien_id) return res.status(400).json({ error: 'chien_id manquant' });

  // ── 2. Vérification d'appartenance (même pattern que chat.js) ─────────────
  // Requête SQL avec id ET user_email : garantit que le chien appartient au JWT.
  const chien = await verifyChienOwnership(chien_id, email);
  if (!chien) return res.status(403).json({ error: 'Chien introuvable ou non autorisé' });

  // ── 3. Limite serveur : une génération par chien par jour ─────────────────
  const today = new Date().toISOString().slice(0, 10);
  if (chien.derniere_generation === today) {
    return res.status(429).json({
      error: 'Menu déjà généré aujourd\'hui pour ce chien',
      rate_limited: true
    });
  }

  // ── 4. Chargement du foyer ────────────────────────────────────────────────
  const foyerRows = await fetchJson(
    `${process.env.SUPABASE_URL}/rest/v1/user?email=eq.${encodeURIComponent(email)}&select=*`
  );
  const foyer = foyerRows[0] || {};

  // ── 5. Génération Claude ──────────────────────────────────────────────────
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

  // ── 6. Enregistrement ─────────────────────────────────────────────────────
  const patch = { derniere_generation: today };
  if (mcFinal.recette)                                                           patch.recette             = mcFinal.recette;
  if (mcFinal.score_sante != null)                                               patch.score_sante         = mcFinal.score_sante;
  if (Array.isArray(mcFinal.score_bullets) && mcFinal.score_bullets.length)      patch.score_bullets       = mcFinal.score_bullets.slice(0, 3);
  if (mcFinal.proteine_principale)                                               patch.proteine_principale = mcFinal.proteine_principale;
  if (Array.isArray(mcFinal.apports) && mcFinal.apports.length)                  patch.apports             = mcFinal.apports;
  if (mcFinal.batch_special)                                                     patch.batch_special       = mcFinal.batch_special;

  if (!patch.recette) {
    return res.status(502).json({ error: 'Réponse Claude incomplète (recette manquante)' });
  }

  await patchChien(chien_id, patch);
  console.log(`[gen-chien] Menu généré pour ${chien.prenom_chien || chien_id} (${email})`);
  return res.status(200).json({ success: true, chien: patch });
};
