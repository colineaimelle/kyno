// api/generate-menu-chien.js
// Génère le menu de tous les chiens actifs d'un foyer à la demande (bouton espace client ou ajout).
// POST authentifié (JWT Supabase), body : { chien_id }
// Enregistre recette, score_sante, score_bullets, apports, proteine_principale,
// batch_special, derniere_generation dans la table chien pour chaque chien actif.
// Enregistre batch_steps, courses, recettes au niveau foyer (table user).
// Requiert la migration : ALTER TABLE chien ADD COLUMN IF NOT EXISTS derniere_generation date;

const { genererMenuFoyer } = require('./_lib/genererMenuChien');

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

async function patchUser(email, fields) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/user?email=eq.${encodeURIComponent(email)}`,
    {
      method: 'PATCH',
      headers: { ...supabaseHeaders(), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify(fields)
    }
  );
  if (!res.ok) {
    const e = await res.text().catch(() => '');
    console.error(`[gen-chien] PATCH user ${email} (${res.status}):`, e);
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

  // ── 2. Vérification d'appartenance ────────────────────────────────────────
  const chien = await verifyChienOwnership(chien_id, email);
  if (!chien) return res.status(403).json({ error: 'Chien introuvable ou non autorisé' });

  // ── 3. Limite serveur : une génération par chien par jour ─────────────────
  const today = new Date().toISOString().slice(0, 10);
  if (chien.derniere_generation === today) {
    return res.status(429).json({ error: 'Menu déjà généré aujourd\'hui pour ce chien', rate_limited: true });
  }

  // ── 4. Chargement du foyer et de tous les chiens actifs ───────────────────
  const [foyerRows, allChiens] = await Promise.all([
    fetchJson(`${process.env.SUPABASE_URL}/rest/v1/user?email=eq.${encodeURIComponent(email)}&select=*`),
    fetchJson(`${process.env.SUPABASE_URL}/rest/v1/chien?user_email=eq.${encodeURIComponent(email)}&actif=eq.true&order=ordre.asc&select=*`),
  ]);
  const foyer = foyerRows[0] || {};

  // ── 5. Pipeline unifié ────────────────────────────────────────────────────
  let pipelineResult;
  try {
    pipelineResult = await genererMenuFoyer(allChiens, foyer);
  } catch (err) {
    console.error(`[gen-chien] Pipeline échoué pour ${email}:`, err.message);
    return res.status(502).json({ error: err.message });
  }

  const { menuData, echecs, stats } = pipelineResult;

  // ── 6. Enregistrement par chien ───────────────────────────────────────────
  const today2 = new Date().toISOString().slice(0, 10);
  await Promise.all((menuData.chiens || []).map(async mc => {
    const chienPatch = { derniere_generation: today2 };
    if (mc.recette)                                                          chienPatch.recette             = mc.recette;
    if (mc.score_sante != null)                                              chienPatch.score_sante         = mc.score_sante;
    if (Array.isArray(mc.score_bullets) && mc.score_bullets.length)         chienPatch.score_bullets       = mc.score_bullets.slice(0, 3);
    if (mc.proteine_principale)                                              chienPatch.proteine_principale = mc.proteine_principale;
    if (Array.isArray(mc.apports) && mc.apports.length)                     chienPatch.apports             = mc.apports;
    if (mc.batch_special)                                                    chienPatch.batch_special       = mc.batch_special;
    if (Array.isArray(mc.ingredients_grammes_crus) && mc.ingredients_grammes_crus.length)
                                                                             chienPatch.ingredients_grammes_crus = mc.ingredients_grammes_crus;
    await patchChien(mc.chien_id, chienPatch);
  }));

  // ── 7. Enregistrement foyer (batch + courses communs) ─────────────────────
  if (menuData.chiens && menuData.chiens.length > 0) {
    await patchUser(email, {
      recettes:     (menuData.chiens || []).map(mc => mc.recette).filter(Boolean),
      batch_steps:  menuData.batch_cooking_commun || [],
      courses:      menuData.courses_commune || [],
      cout_semaine: menuData.cout_semaine || null,
      cout_indus:   menuData.cout_indus || null,
      economie:     menuData.economie || null,
      batch_time:   menuData.batch_time || null,
      menu_envoye:  true,
    });
  }

  console.log(`[gen-chien] ${stats.resultat} (${stats.nbOk}/${stats.nbTotal} chiens, ${stats.tentatives} essai(s)) — ${email}`);

  // ── 8. Réponse ────────────────────────────────────────────────────────────
  const mcRequested = (menuData.chiens || []).find(mc => mc.chien_id === chien_id);
  if (!mcRequested) {
    const echecChien = echecs.find(e => e.chien.id === chien_id);
    if (echecChien) {
      return res.status(502).json({
        error: `Menu bloqué après 2 essais : ${echecChien.raisons2.join('; ')}`,
        blocked: true,
        raisons1: echecChien.raisons1,
        raisons2: echecChien.raisons2,
      });
    }
    return res.status(502).json({ error: 'Réponse Claude incomplète (recette manquante)' });
  }

  return res.status(200).json({
    success: true,
    chien: { ...mcRequested, derniere_generation: today2 },
    stats,
  });
};
