// api/lib/genererMenuChien.js
// Pipeline unique de génération de menu (§1 du brief garde-fous).
// Appelé par cron-menu.js, generate-menu-chien.js, chat.js, magic-link.js.
//
// genererMenuFoyer(chiens, foyer, options)
//   chiens   : tableau de lignes Supabase table `chien` (tous les chiens actifs du foyer)
//   foyer    : ligne Supabase table `user`
//   options  : { saison? }
//
// Retourne { menuData, ciblesKcal, echecs, stats }
//   menuData   : JSON parsé + ajusté (uniquement les chiens ayant passé la vérif)
//   ciblesKcal : { [chien_id]: number }
//   echecs     : [{ chien, raisons1, raisons2 }] — chiens bloqués après 2 essais
//   stats      : { tentatives: 1|2, resultat: 'ok'|'partiel'|'bloque' }
//
// Lance une exception sur erreur d'API Anthropic.

const { getSaison, buildMultiDogMenuPrompt, ajusterRations } = require('./menuGen');
const { besoinKcalJour } = require('./energie');
const { verifierMenu }   = require('./verifierMenu');

const MAX_TOKENS = 8000;

// ── Appel Claude ─────────────────────────────────────────────────────────────
async function appelClaude(chiens, foyer, saison, ciblesKcal, label) {
  const systemPrompt = buildMultiDogMenuPrompt(chiens, foyer, saison, ciblesKcal);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Génère le menu au format JSON demandé. Uniquement le JSON, sans balises markdown.' }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Erreur Claude ${res.status} (${label})`);
  }

  const result = await res.json();
  let raw = result.content[0].text.trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  const fi = raw.indexOf('{');
  const la = raw.lastIndexOf('}');
  if (fi < 0 || la < 0) throw new Error(`JSON introuvable dans la réponse Claude (${label})`);
  if (fi > 0 || la < raw.length - 1) raw = raw.slice(fi, la + 1);

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new Error(`Parsing JSON échoué (${label}) : ${e.message}`); }

  if (!Array.isArray(parsed.chiens) || !parsed.chiens.length) {
    throw new Error(`Champ "chiens" manquant dans la réponse Claude (${label})`);
  }

  return parsed;
}

// ── Vérification de tous les chiens d'un menuData ───────────────────────────
function verifierTous(menuData, chiens, ciblesKcal) {
  const chienMap = {};
  chiens.forEach(c => { chienMap[c.id] = c; });

  const passes = [];
  const echecs = [];

  for (const mc of menuData.chiens) {
    const chien = chienMap[mc.chien_id] || chienMap[String(mc.chien_id)];
    if (!chien) {
      echecs.push({ mc, chien: { id: mc.chien_id, prenom_chien: mc.chien_id }, raisons: [`chien_id ${mc.chien_id} non trouvé dans le foyer`] });
      continue;
    }
    const { ok, raisons } = verifierMenu(mc, chien, ciblesKcal);
    if (ok) {
      passes.push({ mc, chien });
    } else {
      echecs.push({ mc, chien, raisons });
    }
  }
  return { passes, echecs };
}

// ── Email d'alerte menu bloqué ───────────────────────────────────────────────
async function envoyerAlerteBloquage(chien, ciblesKcal, raisons1, raisons2) {
  const alertEmail = process.env.ALERT_EMAIL;
  if (!alertEmail) {
    console.warn('[gen-foyer] ALERT_EMAIL non défini — alerte non envoyée');
    return;
  }
  const nom    = chien.prenom_chien || chien.id;
  const cible  = ciblesKcal[chien.id] || '?';
  const lignes1 = raisons1.map(r => `<li>${r}</li>`).join('');
  const lignes2 = raisons2.map(r => `<li>${r}</li>`).join('');

  await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
    body: JSON.stringify({
      sender: { name: 'Kyno', email: alertEmail },
      to: [{ email: alertEmail, name: 'Coline' }],
      subject: `Menu bloqué : ${nom}`,
      htmlContent: `<h2>Menu bloqué après 2 essais : ${nom}</h2>
<p><b>Chien ID :</b> ${chien.id}</p>
<p><b>Cible énergétique :</b> ${cible} kcal/jour</p>
<h3>Essai 1</h3><ul>${lignes1}</ul>
<h3>Essai 2</h3><ul>${lignes2}</ul>`,
    }),
  }).catch(e => console.error('[gen-foyer] envoi alerte bloquage échoué :', e.message));
}

// ── Email copie Coline (§6) ──────────────────────────────────────────────────
async function envoyerCopieColine(chien, mc, ciblesKcal) {
  const alertEmail = process.env.ALERT_EMAIL;
  if (!alertEmail || process.env.COPIE_MENUS_COLINE !== 'oui') return;

  const nom   = chien.prenom_chien || chien.id;
  const cible = ciblesKcal[chien.id] || '?';
  const rec   = mc.recette || {};
  const ings  = (rec.ingredients || []).map(i => `<li>${i.name} — ${i.qty}</li>`).join('');

  await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
    body: JSON.stringify({
      sender: { name: 'Kyno', email: alertEmail },
      to: [{ email: alertEmail, name: 'Coline' }],
      subject: `Copie — 1er menu : ${nom}`,
      htmlContent: `<h2>Premier menu généré pour ${nom}</h2>
<p><b>Race :</b> ${chien.race||'?'} · <b>Poids :</b> ${chien.poids||'?'} kg · <b>Âge :</b> ${chien.age||'?'}</p>
<p><b>Objectifs :</b> ${(Array.isArray(chien.objectifs)?chien.objectifs:[]).join(', ')||'—'}</p>
<p><b>Allergies :</b> ${(Array.isArray(chien.allergies)?chien.allergies:[]).join(', ')||'aucune'}</p>
<p><b>Cible kcal :</b> ${cible} kcal/jour</p>
<h3>Recette : ${rec.titre||'—'}</h3>
<p>Ration : ${rec.ration||'?'} g/repas</p>
<ul>${ings}</ul>
<p><b>Au moment du repas :</b> ${mc.batch_special||'—'}</p>`,
    }),
  }).catch(e => console.error('[gen-foyer] envoi copie Coline échoué :', e.message));
}

// ── Pipeline principal ───────────────────────────────────────────────────────
async function genererMenuFoyer(chiens, foyer, options = {}) {
  const saison = options.saison || getSaison();

  // 1. Cibles énergétiques
  const ciblesKcal = {};
  for (const c of chiens) {
    const besoin = besoinKcalJour(c);
    if (besoin) {
      ciblesKcal[c.id] = besoin;
      console.log(`[energie] ${c.prenom_chien||c.id} — cible : ${besoin} kcal/jour`);
    }
  }

  const chienMap = {};
  chiens.forEach(c => { chienMap[c.id] = c; });

  // 2. Essai 1 — génération + ajustement + vérification
  const menuData1    = await appelClaude(chiens, foyer, saison, ciblesKcal, 'essai 1');
  const menuData1adj = ajusterRations(menuData1, chienMap, ciblesKcal);
  const { passes: passes1, echecs: echecs1 } = verifierTous(menuData1adj, chiens, ciblesKcal);

  let menuDataFinal;
  let echecs = [];
  let tentatives = 1;

  if (echecs1.length === 0) {
    // Tout passe du premier coup
    menuDataFinal = menuData1adj;
    console.log(`[gen-foyer] Réussi du premier coup (${chiens.map(c=>c.prenom_chien||c.id).join(', ')})`);
  } else {
    // 3. Essai 2 — régénération complète
    tentatives = 2;
    const nomsEchec = echecs1.map(e => e.chien.prenom_chien || e.chien.id).join(', ');
    console.warn(`[gen-foyer] Essai 1 échoué pour : ${nomsEchec} — régénération`);

    const menuData2    = await appelClaude(chiens, foyer, saison, ciblesKcal, 'essai 2');
    const menuData2adj = ajusterRations(menuData2, chienMap, ciblesKcal);
    const { passes: passes2, echecs: echecs2 } = verifierTous(menuData2adj, chiens, ciblesKcal);

    menuDataFinal = menuData2adj;

    if (echecs2.length === 0) {
      console.log(`[gen-foyer] Réussi au deuxième essai`);
    } else {
      const nomsBloque = echecs2.map(e => e.chien.prenom_chien || e.chien.id).join(', ');
      console.error(`[gen-foyer] Bloqué après 2 essais : ${nomsBloque}`);

      for (const e2 of echecs2) {
        const e1 = echecs1.find(e => e.chien.id === e2.chien.id);
        echecs.push({
          chien:    e2.chien,
          raisons1: e1 ? e1.raisons : ['—'],
          raisons2: e2.raisons,
        });
      }

      // Retirer les chiens bloqués du menuData final
      const blockedIds = new Set(echecs.map(e => e.chien.id));
      menuDataFinal = {
        ...menuData2adj,
        chiens: menuData2adj.chiens.filter(mc => !blockedIds.has(mc.chien_id)),
      };
      // Si des chiens ont été retirés, reconstruire les courses depuis les restants
      if (menuDataFinal.chiens.length > 0 && menuDataFinal.chiens.length < menuData2adj.chiens.length) {
        menuDataFinal = ajusterRations(menuDataFinal, chienMap, ciblesKcal);
      }

      // Alertes pour chaque chien bloqué
      for (const e of echecs) {
        await envoyerAlerteBloquage(e.chien, ciblesKcal, e.raisons1, e.raisons2);
      }
    }
  }

  // 4. Copie Coline pour les premiers menus (chien sans recette avant)
  if (menuDataFinal.chiens && menuDataFinal.chiens.length > 0) {
    for (const mc of menuDataFinal.chiens) {
      const chien = chienMap[mc.chien_id];
      if (chien && !chien.recette) {
        await envoyerCopieColine(chien, mc, ciblesKcal);
      }
    }
  }

  const nbOk     = menuDataFinal.chiens ? menuDataFinal.chiens.length : 0;
  const nbTotal  = chiens.length;
  const resultat = echecs.length === 0 ? 'ok' : (nbOk > 0 ? 'partiel' : 'bloque');

  return {
    menuData: menuDataFinal,
    ciblesKcal,
    echecs,
    stats: { tentatives, resultat, nbOk, nbTotal },
  };
}

module.exports = { genererMenuFoyer };
