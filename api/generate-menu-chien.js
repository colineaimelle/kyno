// api/generate-menu-chien.js
// Génère le menu de tous les chiens actifs d'un foyer à la demande (bouton espace client ou ajout).
// POST authentifié (JWT Supabase), body : { chien_id }
//
// §5 — Réponse HTTP 202 immédiate, pipeline en arrière-plan via waitUntil.
// Le frontend poll Supabase (chien.derniere_generation) pour détecter la fin.
//
// §4 — Pour les chiens en échec, l'ancienne recette est re-vérifiée et préservée
// (recette_verifiee = true si elle passe) : un menu existant n'est jamais effacé.

const { waitUntil }      = require('@vercel/functions');
const { genererMenuFoyer } = require('./_lib/genererMenuChien');
const { verifierMenu }   = require('./_lib/verifierMenu');
const { besoinKcalJour } = require('./_lib/energie');

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

// §4 — Pour un chien en échec, re-vérifie son ancienne recette et renvoie le patch à appliquer.
// Retourne toujours { derniere_generation } + recette_verifiee si l'ancienne recette est valide.
function buildPatchEchec(ancien, ciblesKcal, today2) {
  const patch = { derniere_generation: today2 };

  if (!ancien.recette) return patch; // pas d'ancienne recette, rien à préserver

  // Si déjà marquée valide : on ne touche pas recette_verifiee (le PATCH ne l'inclut pas)
  if (ancien.recette_verifiee) return patch;

  // Ancienne recette présente mais non vérifiée → la vérifier maintenant
  const mc = {
    chien_id:                 ancien.id,
    recette:                  ancien.recette,
    ingredients_grammes_crus: Array.isArray(ancien.ingredients_grammes_crus) ? ancien.ingredients_grammes_crus : [],
    batch_special:            ancien.batch_special || '',
    apports:                  Array.isArray(ancien.apports) ? ancien.apports : [],
  };
  const cible = ciblesKcal[ancien.id] || besoinKcalJour(ancien);
  if (!cible) return patch;

  const { ok, raisons } = verifierMenu(mc, ancien, { [ancien.id]: cible });
  if (ok) {
    patch.recette_verifiee = true;
    console.log(`[gen-chien] §4 — ancienne recette de ${ancien.prenom_chien || ancien.id} re-vérifiée : valide`);
  } else {
    console.warn(`[gen-chien] §4 — ancienne recette de ${ancien.prenom_chien || ancien.id} invalide : ${raisons.join('; ')}`);
  }
  return patch;
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

  // ── 5. §5 — Réponse 202 immédiate, pipeline en arrière-plan ──────────────
  res.status(202).json({ status: 'generating', chien_id });

  waitUntil((async () => {
    const today2 = new Date().toISOString().slice(0, 10);

    // ── Pipeline ────────────────────────────────────────────────────────────
    let pipelineResult;
    try {
      pipelineResult = await genererMenuFoyer(allChiens, foyer);
    } catch (err) {
      console.error(`[gen-chien] Pipeline échoué pour ${email}:`, err.message);
      // Ne pas marquer derniere_generation → l'utilisateur peut réessayer
      return;
    }

    const { menuData, echecs, ciblesKcal, stats } = pipelineResult;

    // ── 6. Enregistrement des chiens ayant réussi la vérification ───────────
    // Promise.allSettled : un PATCH échoué n'annule pas les autres.
    // Si le PATCH échoue (ex. colonne inconnue), derniere_generation n'est pas écrite
    // → le polling côté client expire après 90 s et propose de réessayer
    // → le rate-limit quotidien n'est pas déclenché → l'utilisateur peut relancer.
    const patchResults = await Promise.allSettled((menuData.chiens || []).map(async mc => {
      const chienPatch = { derniere_generation: today2 };
      if (mc.recette)                                                          chienPatch.recette             = mc.recette;
      if (mc.recette)                                                          chienPatch.recette_verifiee    = true;
      if (mc.score_sante != null)                                              chienPatch.score_sante         = mc.score_sante;
      if (Array.isArray(mc.score_bullets) && mc.score_bullets.length)         chienPatch.score_bullets       = mc.score_bullets.slice(0, 3);
      if (mc.proteine_principale)                                              chienPatch.proteine_principale = mc.proteine_principale;
      if (Array.isArray(mc.apports) && mc.apports.length)                     chienPatch.apports             = mc.apports;
      if (mc.batch_special)                                                    chienPatch.batch_special       = mc.batch_special;
      if (Array.isArray(mc.ingredients_grammes_crus) && mc.ingredients_grammes_crus.length)
                                                                               chienPatch.ingredients_grammes_crus = mc.ingredients_grammes_crus;
      await patchChien(mc.chien_id, chienPatch);
    }));
    patchResults.forEach((r, i) => {
      if (r.status === 'rejected')
        console.error(`[gen-chien] PATCH chien[${i}] rejeté :`, r.reason?.message);
    });

    // ── 7. §4 — Chiens en échec : préserver et re-vérifier l'ancienne recette
    for (const { chien: chienEchec } of echecs) {
      const ancien = allChiens.find(c => c.id === chienEchec.id);
      if (!ancien) continue;
      const patch = buildPatchEchec(ancien, ciblesKcal, today2);
      await patchChien(ancien.id, patch).catch(e =>
        console.error('[gen-chien] §4 PATCH chien échec:', e.message)
      );
    }

    // ── 8. Enregistrement foyer (batch + courses) ───────────────────────────
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
  })());
};
