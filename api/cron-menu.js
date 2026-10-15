// api/cron-menu.js — v2
// Cron quotidien (5h UTC via GitHub Actions).
// Ne traite que les utilisateurs dont le jour_envoi correspond au jour courant
// en heure Europe/Paris. Anti-doublon via dernier_menu_envoye_le.

// ── HELPERS TIMEZONE ──────────────────────────────────────────
function getDayParis() {
  // Retourne 1=lundi … 7=dimanche (ISO) en heure Europe/Paris
  const parisDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const d = parisDate.getDay(); // 0=dim … 6=sam
  return d === 0 ? 7 : d;
}

function getTodayParis() {
  // Retourne YYYY-MM-DD en heure Europe/Paris
  return new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
}

// ── SLEEP & RETRY ─────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, label, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await fn();
    if (result.ok) return result;
    const retryable = result.status === 429 || result.status >= 500;
    if (!retryable || attempt === maxAttempts) return result;
    const delay = Math.pow(2, attempt) * 1000;
    console.warn(`[retry ${attempt}/${maxAttempts}] ${label} — statut ${result.status}, attente ${delay}ms`);
    await sleep(delay);
  }
}

module.exports = async function handler(req, res) {

  const authHeader = req.headers['authorization'] || '';
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    // ── Mode test : email_test isole un seul utilisateur ────────
    const emailTest = req.body?.email_test ? String(req.body.email_test).trim() : null;

    // ── Jour cible : paramètre manuel (workflow_dispatch) OU jour Paris ──
    const jourParam = req.body?.jour ? parseInt(req.body.jour) : null;
    const jourCible = (jourParam >= 1 && jourParam <= 7) ? jourParam : getDayParis();
    const todayParis = getTodayParis();
    const cutoff5j = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const cutoff14j = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    if (emailTest) {
      console.log(`[cron-menu] MODE TEST — email_test=${emailTest}`);
    } else {
      console.log(`[cron-menu] jour_cible=${jourCible}, today_paris=${todayParis}`);
    }

    // ── Récupérer les utilisateurs ────────────────────────────
    // Mode test : 1 seul utilisateur par email, quel que soit son jour_envoi
    // Mode normal : filtre par jour_envoi + statut
    const supabaseQuery = emailTest
      ? `${process.env.SUPABASE_URL}/rest/v1/user?email=eq.${encodeURIComponent(emailTest)}&select=*`
      : `${process.env.SUPABASE_URL}/rest/v1/user?statut=in.("beta","actif")&menu_envoye=eq.true&jour_envoi=eq.${jourCible}&select=*`;

    const usersRes = await fetch(supabaseQuery, {
        headers: {
          'apikey': process.env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
        }
      });

    const users = await usersRes.json();
    if (!Array.isArray(users) || !users.length) {
      console.log('[cron-menu] Aucun abonné pour ce jour.');
      return res.status(200).json({ success: true, processed: 0, envoyes: 0, ignores: 0, echecs: 0 });
    }

    const saison = getSaison();
    const recap = { envoyes: 0, ignores: 0, echecs: 0, relances: 0, details: [] };

    // ── Traitement par lots de 3 ──────────────────────────────
    const BATCH_SIZE = 3;
    const BATCH_PAUSE = 2000;

    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const lot = users.slice(i, i + BATCH_SIZE);

      await Promise.all(lot.map(async profile => {
        const nom = profile.prenom_chien || profile.email;

        // Anti-doublon : skip si déjà envoyé dans les 5 derniers jours
        if (profile.dernier_menu_envoye_le && profile.dernier_menu_envoye_le >= cutoff5j) {
          console.log(`[skip doublon] ${nom} — dernier envoi ${profile.dernier_menu_envoye_le}`);
          recap.ignores++;
          recap.details.push({ email: profile.email, status: 'ignore', reason: 'doublon' });
          return;
        }

        // Email de relance : seulement si c'est le jour d'envoi ET inactif > 14j
        const derniereConnexion = profile.derniere_connexion ? new Date(profile.derniere_connexion) : null;
        const relanceEligible = !derniereConnexion || derniereConnexion < cutoff14j;
        if (relanceEligible) {
          // Vérifier qu'on n'a pas déjà relancé cette semaine (dernier_menu_envoye_le comme proxy)
          const derniereRelanceDateISO = profile.derniere_relance || null;
          const cutoff7j = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          if (!derniereRelanceDateISO || derniereRelanceDateISO < cutoff7j) {
            try {
              await sendEmailRelance(profile.email, profile.prenom_chien || profile.prenom || 'ton chien');
              await patchSupabase(profile.email, { derniere_relance: todayParis });
              recap.relances++;
              console.log(`[relance] ${nom}`);
            } catch (relErr) {
              console.error(`[relance erreur] ${nom}:`, relErr.message);
            }
          }
        }

        // Génération du menu
        try {
          await generateMenuForUser(profile, saison, todayParis);
          recap.envoyes++;
          recap.details.push({ email: profile.email, status: 'ok' });
          console.log(`[ok] Menu envoyé pour ${nom}`);
        } catch (err) {
          recap.echecs++;
          recap.details.push({ email: profile.email, status: 'error', error: err.message });
          console.error(`[erreur] ${nom}:`, err.message);
        }
      }));

      if (i + BATCH_SIZE < users.length) await sleep(BATCH_PAUSE);
    }

    console.log(`[cron-menu] Récap : ${recap.envoyes} envoyés, ${recap.ignores} ignorés, ${recap.echecs} échecs, ${recap.relances} relances`);
    const hasErrors = recap.echecs > 0;
    return res.status(hasErrors ? 500 : 200).json({ success: !hasErrors, jourCible, todayParis, ...recap });

  } catch (error) {
    console.error('Erreur cron-menu.js:', error);
    return res.status(500).json({ error: 'Erreur serveur', message: error.message });
  }
};

async function generateMenuForUser(profile, saison, todayParis) {
  const email = profile.email;
  const nom = profile.prenom_chien || profile.prenom || 'ton chien';
  const pm = profile.poids ? Math.pow(profile.poids, 0.75).toFixed(2) : 'à calculer';

  // ── 1. Archiver le menu actuel avant remplacement ──────────
  if (Array.isArray(profile.recettes) && profile.recettes.length > 0) {
    const recetteActuelle = profile.recettes[0];
    const existingHistorique = Array.isArray(profile.historique_menus) ? profile.historique_menus : [];
    const newEntry = {
      score: profile.score_sante || 85,
      label: getLabelSemaine(),
      note: recetteActuelle.titre || ''
    };
    const historiqueUpdated = [...existingHistorique, newEntry].slice(-10);
    await patchSupabase(email, { historique_menus: historiqueUpdated });
  }

  // ── 2. Archiver le poids actuel ────────────────────────────
  if (profile.poids) {
    const existingPoids = Array.isArray(profile.poids_historique) ? profile.poids_historique : [];
    const poidsEntry = { label: `S-${getIsoWeek()}`, poids: profile.poids };
    const poidsUpdated = [...existingPoids, poidsEntry].slice(-6);
    await patchSupabase(email, { poids_historique: poidsUpdated });
  }

  // ── 3. Générer le nouveau menu via Claude (retry 429/5xx) ────
  const menuRes = await withRetry(
    () => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 8000,
        system: buildMenuPrompt(profile, saison, pm, profile.proteine_principale || null),
        messages: [{ role: 'user', content: 'Génère le menu de la semaine au format JSON demandé. Réponds uniquement avec le JSON, sans texte avant ni après, sans balises markdown.' }]
      })
    }),
    `Claude menu pour ${nom}`
  );

  if (!menuRes.ok) {
    const err = await menuRes.json().catch(() => ({}));
    throw new Error(err.error?.message || `Erreur API Anthropic (${menuRes.status})`);
  }

  const menuResult = await menuRes.json();
  let rawText = menuResult.content[0].text.trim();
  rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  const first = rawText.indexOf('{');
  const last = rawText.lastIndexOf('}');
  if (first > 0 || last < rawText.length - 1) rawText = rawText.slice(first, last + 1);

  let menuData;
  try {
    menuData = JSON.parse(rawText);
  } catch (parseErr) {
    throw new Error(`Parsing JSON menu échoué: ${parseErr.message}`);
  }

  // ── 4. Sauvegarder le menu core ────────────────────────────
  await patchSupabase(email, {
    menu_texte:   menuData.email_html || '',
    recettes:     menuData.recette ? [menuData.recette] : [],
    batch_steps:  menuData.batch_steps || [],
    courses:      menuData.courses || [],
    cout_semaine: menuData.cout_semaine || null,
    cout_indus:   menuData.cout_indus || null,
    economie:     menuData.economie || null,
    batch_time:   menuData.batch_time || null,
    menu_envoye:  true
  });

  // ── 5. score_sante + score_bullets (PATCH séparé) ────────────
  if (menuData.score_sante != null) {
    const scorePatch = { score_sante: menuData.score_sante };
    if (Array.isArray(menuData.score_bullets) && menuData.score_bullets.length > 0) {
      scorePatch.score_bullets = menuData.score_bullets.slice(0, 3);
    }
    const patchScore = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/user?email=eq.${encodeURIComponent(email)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(scorePatch)
      }
    );
    if (!patchScore.ok) {
      const errBody = await patchScore.text().catch(() => '');
      console.error(`Erreur PATCH score_sante pour ${email} (${patchScore.status}):`, errBody);
    }
  }

  // ── 6. proteine_principale (colonne optionnelle — PATCH séparé) ──
  if (menuData.proteine_principale) {
    const patchProteine = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/user?email=eq.${encodeURIComponent(email)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ proteine_principale: menuData.proteine_principale })
      }
    );
    if (!patchProteine.ok) {
      const errBody = await patchProteine.text().catch(() => '');
      console.error(`Erreur PATCH proteine_principale pour ${email} (${patchProteine.status}):`, errBody);
    }
  }

  // ── 6. Apports (colonne optionnelle — PATCH séparé) ────────
  if (Array.isArray(menuData.apports) && menuData.apports.length > 0) {
    const patchApports = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/user?email=eq.${encodeURIComponent(email)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ apports: menuData.apports })
      }
    );
    if (!patchApports.ok) {
      const errBody = await patchApports.text().catch(() => '');
      console.error(`Erreur PATCH apports pour ${email} (${patchApports.status}):`, errBody);
    }
  }

  // ── 6. batch_special (colonne optionnelle — PATCH séparé) ──
  if (menuData.batch_special) {
    const patchSpecial = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/user?email=eq.${encodeURIComponent(email)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ batch_special: menuData.batch_special })
      }
    );
    if (!patchSpecial.ok) {
      const errBody = await patchSpecial.text().catch(() => '');
      console.error(`Erreur PATCH batch_special pour ${email} (${patchSpecial.status}):`, errBody);
    }
  }

  // ── 7. Envoyer l'email ─────────────────────────────────────
  await sendEmailMenu(email, nom, menuData, profile, saison);

  // ── 8. Marquer l'envoi (seulement après succès) ────────────
  if (todayParis) {
    await patchSupabase(email, { dernier_menu_envoye_le: todayParis });
  }
}

async function patchSupabase(email, fields) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/user?email=eq.${encodeURIComponent(email)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(fields)
    }
  );
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.error(`Erreur PATCH Supabase (${res.status}):`, errBody);
  }
}

function getLabelSemaine() {
  const now = new Date();
  const mois = ['jan', 'fév', 'mar', 'avr', 'mai', 'juin', 'juil', 'août', 'sep', 'oct', 'nov', 'déc'];
  return `Semaine du ${now.getDate()} ${mois[now.getMonth()]}`;
}

function getIsoWeek() {
  const now = new Date();
  const jan1 = new Date(now.getFullYear(), 0, 1);
  return Math.ceil(((now - jan1) / 86400000 + jan1.getDay() + 1) / 7);
}

function getSaison() {
  const m = new Date().getMonth() + 1;
  if (m >= 3 && m <= 5) return 'Printemps';
  if (m >= 6 && m <= 8) return 'Été';
  if (m >= 9 && m <= 11) return 'Automne';
  return 'Hiver';
}

function buildMenuPrompt(profile, saison, pm, proteineActuelle = null) {
  const nom = profile.prenom_chien || profile.prenom || 'ton chien';
  const intolerances = Array.isArray(profile.allergies) ? profile.allergies : [];
  const equipement = Array.isArray(profile.equipement) ? profile.equipement : [];

  const interdictionBlock = intolerances.length > 0
    ? `⚠️ INTERDICTION ABSOLUE — LIS CECI EN PREMIER :
Les ingrédients suivants sont STRICTEMENT INTERDITS dans ce menu : ${intolerances.join(', ')}.
NE LES UTILISE JAMAIS, ni dans les recettes, ni dans la liste de courses, ni dans le email_html.
Peu importe leur valeur nutritionnelle. Une violation de cette règle met la vie du chien en danger.
Si tu n'as aucun autre choix pour une catégorie d'ingrédient, choisis une alternative totalement différente.

`
    : '';

  const rotationBlock = proteineActuelle
    ? `⚠️ ROTATION DES PROTÉINES — OBLIGATOIRE :
Le menu précédent contenait : ${proteineActuelle}. Utilise OBLIGATOIREMENT une protéine principale différente cette semaine. Ne répète jamais la même protéine deux semaines de suite.

`
    : '';

  return `${interdictionBlock}${rotationBlock}Tu es Kyno, expert en nutrition canine. Tu génères des menus hebdomadaires pratiques et réalistes basés sur NRC 2006 et FEDIAF 2023. Tu tutoies le propriétaire. Tu réponds UNIQUEMENT en JSON valide, sans aucun texte avant ou après, sans balises markdown \`\`\`.

## PROFIL
- Prénom : ${nom}
- Race : ${profile.race || 'non renseigné'}
- Poids : ${profile.poids ? profile.poids + ' kg' : 'non renseigné'} — Poids métabolique : ${pm} kg PM
- Activité : ${profile.activite || 'non renseigné'}
- Saison : ${saison}
- Mode alimentaire : ${profile.modeAlimentaire || profile.mode_alimentaire || 'ration ménagère'}
- Budget : ${profile.budget || 'moyen'}
- Équipement : ${equipement.join(', ') || 'standard'}
- Temps préparation : ${profile.tempsPrep || profile.temps_prep || 'non renseigné'}
- Intolérances INTERDITES (aucune exception) : ${intolerances.length > 0 ? intolerances.join(', ') : 'aucune'}

## CONCEPT DU MENU
Le propriétaire cuisine UNE SEULE FOIS par semaine — une grande marmite.
- 1 SEULE recette, servie matin ET soir (×14 portions : 7 jours × 2 repas)
- La recette est cuisinée en grande quantité pour toute la semaine
- Conservation : jours 1-2-3 au réfrigérateur, jours 4-5-6-7 au congélateur en portions
- Les portions sont décongelées la veille au frigo
- Les compléments sensibles (huile, CMV, etc.) sont ajoutés AU MOMENT DU REPAS, jamais à la cuisson
- Adapte les légumes et protéines à la saison : ${saison}

## STRUCTURE JSON EXACTE À RESPECTER

{
  "recette": {
    "moment": "Matin et soir",
    "color": "#2FA35E",
    "titre": "nom de la recette, court et appétissant",
    "ration": nombre en grammes par repas (matin = soir = même quantité),
    "ingredients": [
      { "name": "nom de l'ingrédient", "qty": "quantité par repas, ex: 80 g" }
    ],
    "note": "note nutritionnelle courte, 1 phrase, pourquoi cette recette est bonne pour ${nom}"
  },
  "batch_special": "instruction à ajouter UNIQUEMENT au moment du repas, jamais à la cuisson.",
  "batch_time": "≈ XX min de prépa",
  "batch_steps": [
    { "n": 1, "text": "étape détaillée et concrète, avec temps de cuisson si pertinent" },
    { "n": 2, "text": "..." },
    { "n": 3, "text": "..." },
    { "n": 4, "text": "..." }
  ],
  "courses": [
    { "cat": "Viandes & poissons", "items": [{ "name": "ingrédient", "qty": "quantité totale pour 7 jours, ex: 560 g" }] },
    { "cat": "Légumes & féculents", "items": [{ "name": "ingrédient", "qty": "quantité totale pour 7 jours" }] },
    { "cat": "Compléments", "items": [{ "name": "ingrédient", "qty": "quantité totale pour 7 jours" }] }
  ],
  "cout_semaine": "XX,XX €",
  "cout_indus": "XX €",
  "economie": "XX,XX €",
  "apports": [
    { "nom": "Calories", "unite": "kcal", "valeur": <kcal réels par repas>, "cible": <besoins journaliers / 2 selon NRC 2006>, "pct": <arrondi valeur/cible×100>, "color": "#F2843C" },
    { "nom": "Protéines", "unite": "g", "valeur": <g protéines par repas>, "cible": <cible par repas selon FEDIAF 2023>, "pct": <arrondi>, "color": "#2FA35E" },
    { "nom": "Lipides", "unite": "g", "valeur": <g lipides par repas>, "cible": <cible par repas>, "pct": <arrondi>, "color": "#EC6592" },
    { "nom": "Calcium", "unite": "g", "valeur": <g calcium par repas>, "cible": <cible par repas>, "pct": <arrondi>, "color": "#3E8FC4" },
    { "nom": "Oméga-3", "unite": "g", "valeur": <g oméga-3 par repas>, "cible": <cible par repas>, "pct": <arrondi>, "color": "#FFCE2E" }
  ],
  "proteine_principale": "nom court de la protéine principale (ex: dinde, bœuf, saumon, agneau, poulet, cabillaud)",
  "score_sante": <nombre entier entre 0 et 100 évaluant l'état de santé global de ${nom} d'après son profil>,
  "score_bullets": [
    { "ok": true, "text": "point positif court (ex: Poids stable et idéal pour sa race)" },
    { "ok": false, "text": "point à surveiller (ex: Digestion à consolider)" }
  ],
  "email_html": "Texte complet du menu en Markdown. Utilise \\n pour les retours à la ligne et ** pour le gras. Commence par 'Voici le menu de la semaine de ${nom} !'."
}

## RÈGLES IMPORTANTES
- "ration" dans recette = quantité PAR REPAS (matin et soir identiques)
- "qty" dans ingredients = quantité par repas
- "qty" dans courses > items = quantité TOTALE pour 7 jours (×14 repas)
- "batch_special" : compléments ajoutés au moment du repas uniquement (huile, CMV, levure, etc.) — jamais cuits
- "proteine_principale" : une seule protéine en minuscules, sans article (ex: "dinde" pas "de la dinde")${proteineActuelle ? ` — DOIT être différente de "${proteineActuelle}"` : ''}
- "score_sante" : évalue objectivement d'après poids, activité, antécédents, allergies, objectifs (85-100 = excellent, 70-84 = bonne forme, 55-69 = à surveiller, <55 = vigilance)
- "score_bullets" : 2 à 3 points max ({ok: true/false, text: phrase courte}) — mix points positifs et points à surveiller selon le profil
- INTERDICTION ABSOLUE (rappel final) : ${intolerances.length > 0 ? `les ingrédients suivants ne doivent apparaître nulle part dans ta réponse : ${intolerances.join(', ')}` : 'aucune intolérance déclarée'}
- Le JSON doit être strictement valide : pas de virgule finale, toutes les clés entre guillemets doubles
- Pour "apports" : calcule les besoins énergétiques avec NRC 2006 (130 × PM^0.75 × facteur activité : sédentaire 1.0, modéré 1.4, actif 1.8) divisés par 2. Estime les valeurs réelles depuis les ingrédients. "pct" = arrondi entier. "valeur" et "cible" sont des nombres (pas des chaînes)`;
}

async function sendEmailRelance(email, prenom) {
  const emailRes = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': process.env.BREVO_API_KEY
    },
    body: JSON.stringify({
      sender: { name: 'Kyno', email: 'colinemngl@gmail.com' },
      to: [{ email, name: prenom }],
      subject: `Des nouvelles de ${prenom} ? 🐾`,
      htmlContent: `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F3F7F1;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F3F7F1;padding:48px 20px;">
    <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">

      <tr>
        <td style="padding:0 8px 28px;text-align:center;">
          <div style="display:inline-flex;align-items:center;gap:8px;">
            <div style="width:28px;height:28px;border-radius:50%;border:1.5px solid #2FA35E;display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#2FA35E;font-family:Arial,sans-serif;">K</div>
            <span style="font-size:15px;font-weight:700;color:#2B3A2E;letter-spacing:0.04em;">kyno</span>
          </div>
        </td>
      </tr>

      <tr>
        <td style="background:#FFFFFF;border-radius:20px;padding:40px 36px;border:1px solid #E3EDE1;text-align:center;">
          <svg width="52" height="52" viewBox="0 0 52 52" xmlns="http://www.w3.org/2000/svg" style="margin-bottom:16px;">
            <circle cx="26" cy="26" r="26" fill="#FBE4D8"/>
            <path d="M16 20c0-2 1.5-4 3.2-4 1.2 0 2.2 1 2.6 2.4" stroke="#2B3A2E" stroke-width="1.6" stroke-linecap="round" fill="none"/>
            <path d="M36 20c0-2-1.5-4-3.2-4-1.2 0-2.2 1-2.6 2.4" stroke="#2B3A2E" stroke-width="1.6" stroke-linecap="round" fill="none"/>
            <ellipse cx="26" cy="29" rx="10" ry="8.5" fill="#F2843C"/>
            <circle cx="22" cy="27" r="1.4" fill="#2B3A2E"/>
            <circle cx="30" cy="27" r="1.4" fill="#2B3A2E"/>
            <path d="M24 32c0.8 1 2.2 1 3 0" stroke="#2B3A2E" stroke-width="1.4" stroke-linecap="round" fill="none"/>
            <ellipse cx="26" cy="30.5" rx="1.4" ry="1" fill="#2B3A2E"/>
          </svg>
          <p style="margin:0 0 10px;font-size:19px;font-weight:700;color:#2B3A2E;line-height:1.4;">Des nouvelles de <span style="color:#2FA35E;">${prenom}</span> ?</p>
          <p style="margin:0 0 28px;font-size:14px;color:#8A978A;line-height:1.8;max-width:380px;margin-left:auto;margin-right:auto;">Ça fait deux semaines qu'on ne t'a pas vue par ici. Son nouveau menu de la semaine est prêt quand tu veux faire le point.</p>
          <a href="https://project-jlc6z.vercel.app/espace-client.html" style="display:inline-block;background:#2FA35E;color:white;padding:14px 30px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:700;">Voir l'espace de ${prenom} →</a>
        </td>
      </tr>

      <tr>
        <td style="padding:24px 32px 0;text-align:center;">
          <a href="mailto:colinemngl@gmail.com" style="font-size:11px;color:#9AA69B;text-decoration:none;">kyno · colinemngl@gmail.com</a>
        </td>
      </tr>

    </table>
    </td></tr>
  </table>
</body></html>`
    })
  });
  if (!emailRes.ok) {
    const errBody = await emailRes.text().catch(() => '');
    throw new Error(`Brevo relance ${emailRes.status}: ${errBody}`);
  }
}

async function sendEmailMenu(email, prenom, menuData, profile, saison) {
  const emailRes = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': process.env.BREVO_API_KEY
    },
    body: JSON.stringify({
      sender: { name: 'Kyno', email: 'colinemngl@gmail.com' },
      to: [{ email, name: prenom }],
      subject: `Le menu de la semaine de ${prenom} ✦`,
      htmlContent: buildEmailMenuHtml(prenom, menuData, profile, saison)
    })
  });

  if (!emailRes.ok) {
    const errBody = await emailRes.text().catch(() => '');
    throw new Error(`Brevo menu ${emailRes.status}: ${errBody}`);
  }
}

function buildEmailMenuHtml(prenom, menuData, profile = {}, saison = '') {
  const recette = menuData.recette || {};
  const race = profile.race || 'non renseigné';
  const poids = profile.poids ? profile.poids + ' kg' : '';
  const sousTitre = [race, poids].filter(Boolean).join(' · ');
  const weekLabel = getLabelSemaine();

  const stepsHtml = (menuData.batch_steps || [])
    .map(s => `${s.n}. ${s.text}`)
    .join('<br>');

  const coursesHtml = (menuData.courses || [])
    .map(cat => `${cat.cat} : ` + (cat.items || []).map(i => `${i.name} ${i.qty}`).join(', '))
    .join('<br>');

  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F3F7F1;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F3F7F1;padding:48px 20px;">
    <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">

      <tr>
        <td style="padding:0 8px 28px;text-align:center;">
          <div style="display:inline-flex;align-items:center;gap:8px;">
            <div style="width:28px;height:28px;border-radius:50%;border:1.5px solid #2FA35E;display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#2FA35E;font-family:Arial,sans-serif;">K</div>
            <span style="font-size:15px;font-weight:700;color:#2B3A2E;letter-spacing:0.04em;">kyno</span>
          </div>
        </td>
      </tr>

      <tr>
        <td style="background:#FFFFFF;border-radius:20px 20px 0 0;padding:28px 32px;border:1px solid #E3EDE1;border-bottom:none;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td width="56" valign="top">
                <svg width="52" height="52" viewBox="0 0 52 52" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="26" cy="26" r="26" fill="#FBE4D8"/>
                  <path d="M16 20c0-2 1.5-4 3.2-4 1.2 0 2.2 1 2.6 2.4" stroke="#2B3A2E" stroke-width="1.6" stroke-linecap="round" fill="none"/>
                  <path d="M36 20c0-2-1.5-4-3.2-4-1.2 0-2.2 1-2.6 2.4" stroke="#2B3A2E" stroke-width="1.6" stroke-linecap="round" fill="none"/>
                  <ellipse cx="26" cy="29" rx="10" ry="8.5" fill="#F2843C"/>
                  <circle cx="22" cy="27" r="1.4" fill="#2B3A2E"/>
                  <circle cx="30" cy="27" r="1.4" fill="#2B3A2E"/>
                  <path d="M24 32c0.8 1 2.2 1 3 0" stroke="#2B3A2E" stroke-width="1.4" stroke-linecap="round" fill="none"/>
                  <ellipse cx="26" cy="30.5" rx="1.4" ry="1" fill="#2B3A2E"/>
                </svg>
              </td>
              <td valign="middle" style="padding-left:12px;">
                <p style="margin:0;font-size:17px;font-weight:700;color:#2B3A2E;">${prenom}</p>
                <p style="margin:2px 0 0;font-size:12px;color:#8A978A;">${sousTitre}</p>
              </td>
              <td align="right" valign="middle">
                <span style="display:inline-block;background:#E3EDE1;color:#2FA35E;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:6px 12px;border-radius:20px;">${weekLabel}</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <tr>
        <td style="background:#2B3A2E;padding:24px 32px;">
          <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:#7FBE98;font-weight:700;">Menu de la semaine</p>
          <p style="margin:0;font-size:22px;font-weight:700;color:#FBFDF7;line-height:1.3;">${recette.titre || 'Le menu de ' + prenom}</p>
        </td>
      </tr>

      <tr>
        <td style="background:#FFFFFF;padding:32px 32px 4px;border:1px solid #E3EDE1;border-top:none;">

          <p style="margin:0 0 24px;font-size:14.5px;color:#3C473D;line-height:1.9;">${recette.note || `Une seule recette, cuisinée en une fois, pour toute la semaine de ${prenom} — matin et soir.`}</p>

          <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
            <tr>
              <td width="50%" style="background:#F3F7F1;border-radius:10px;padding:16px 20px;">
                <p style="margin:0 0 2px;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#8A978A;font-weight:700;">Par repas</p>
                <p style="margin:0;font-size:20px;font-weight:700;color:#2B3A2E;">${recette.ration || '—'}</p>
              </td>
              <td width="12"></td>
              <td width="50%" style="background:#F3F7F1;border-radius:10px;padding:16px 20px;">
                <p style="margin:0 0 2px;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#8A978A;font-weight:700;">Temps de prépa</p>
                <p style="margin:0;font-size:20px;font-weight:700;color:#2B3A2E;">${menuData.batch_time || '—'}</p>
              </td>
            </tr>
          </table>

          <h2 style="margin:0 0 10px;font-size:15px;font-weight:700;color:#2B3A2E;border-top:1px solid #EDF2EA;padding-top:22px;">Les étapes</h2>
          <p style="margin:0 0 24px;font-size:14.5px;color:#3C473D;line-height:1.9;">${stepsHtml}</p>

          ${menuData.batch_special ? `
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
            <tr>
              <td style="background:#FBE4D8;border-radius:10px;padding:16px 18px;">
                <p style="margin:0;font-size:13px;color:#8A4420;line-height:1.7;"><strong>Au moment du repas seulement :</strong> ${menuData.batch_special}</p>
              </td>
            </tr>
          </table>` : ''}

          <h2 style="margin:0 0 10px;font-size:15px;font-weight:700;color:#2B3A2E;">Liste de courses (7 jours)</h2>
          <p style="margin:0 0 28px;font-size:14.5px;color:#3C473D;line-height:1.9;">${coursesHtml}</p>

        </td>
      </tr>

      <tr>
        <td style="background:#FFFFFF;padding:8px 32px 36px;border:1px solid #E3EDE1;border-top:none;border-radius:0 0 20px 20px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="text-align:center;padding-top:8px;">
              <a href="https://project-jlc6z.vercel.app/espace-client.html" style="display:inline-block;background:#2FA35E;color:white;padding:14px 30px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:700;">Voir le menu complet →</a>
            </td></tr>
          </table>
        </td>
      </tr>

      <tr>
        <td style="padding:24px 32px 0;">
          <p style="margin:0 0 12px;font-size:11px;color:#9AA69B;line-height:1.7;">⚠ Ce menu est éducatif et ne remplace pas un avis vétérinaire.</p>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td><span style="font-size:12px;font-weight:700;color:#5B6B5D;">kyno</span> <span style="font-size:11px;color:#9AA69B;">· Lyon, France</span></td>
              <td align="right"><a href="mailto:colinemngl@gmail.com" style="font-size:11px;color:#9AA69B;text-decoration:none;">colinemngl@gmail.com</a></td>
            </tr>
          </table>
        </td>
      </tr>

    </table>
    </td></tr>
  </table>
</body>
</html>`;
}
