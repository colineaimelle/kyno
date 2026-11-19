// api/generate.js — v5
// Aligné avec le nouveau quiz 22 questions (jour d'envoi ajouté)
// Champs quiz → Supabase → espace client

const { waitUntil } = require('@vercel/functions');
const { besoinKcalJour } = require('./lib/energie');

const SITE_URL = process.env.SITE_URL || (process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'https://kyno.fr');
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || 'colinemngl@gmail.com';

// ── HELPER : fusionner tableau + champ "autre" ─────────────
function mergeAutre(arr, autre, excludeVals = []) {
  const base = Array.isArray(arr)
    ? arr.filter(v => !excludeVals.includes(v) && v !== 'autre' && v !== 'autres' && v !== 'autre maladie' && v !== 'problème spécifique')
    : [];
  if (autre && typeof autre === 'string' && autre.trim()) base.push(autre.trim());
  return base;
}

// ── SAISON ─────────────────────────────────────────────────
function getSaison() {
  const m = new Date().getMonth() + 1;
  if (m >= 3 && m <= 5) return 'Printemps';
  if (m >= 6 && m <= 8) return 'Été';
  if (m >= 9 && m <= 11) return 'Automne';
  return 'Hiver';
}

// ── SUPABASE — FOYER (table "user") ───────────────────────
function parseJourEnvoi(v) {
  if (Number.isInteger(v) && v >= 1 && v <= 7) return v;
  const n = parseInt(v);
  if (Number.isInteger(n) && n >= 1 && n <= 7) return n;
  return 1;
}

async function saveFoyerToSupabase(data, statut) {
  const coursesOu = mergeAutre(data.coursesOu, null);
  const attentes = data.attentes && data.attentes.trim() ? data.attentes.trim() : null;

  const body = {
    email:          data.email,
    plan:           data.plan || 'beta',
    statut,
    rapport_envoye: true,
    menu_envoye:    false,
    equipement:     Array.isArray(data.equipement) ? data.equipement : [],
    temps_prep:     data.tempsPrep || null,
    courses_ou:     coursesOu,
    attentes,
    jour_envoi:     parseJourEnvoi(data.jourEnvoi),
  };

  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/user?on_conflict=email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=minimal,resolution=merge-duplicates'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    console.error('Erreur saveFoyerToSupabase:', response.status, errBody);
  }
  return response;
}

// ── SUPABASE — CHIEN (table "chien") ───────────────────────
async function getNextOrdreForEmail(email) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/chien?user_email=eq.${encodeURIComponent(email)}&select=ordre&order=ordre.desc&limit=1`,
    {
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
      }
    }
  );
  if (!res.ok) return 1;
  const rows = await res.json().catch(() => []);
  return rows.length ? (rows[0].ordre || 0) + 1 : 1;
}

async function saveChienToSupabase(email, data, ordre) {
  const intolerances      = mergeAutre(data.intolerances, data.intolerancesAutre, ['aucune']);
  const sensibilites      = mergeAutre(data.tracasQuotidiens, null, ['aucun']);
  const comportementArr   = Array.isArray(data.comportement)
    ? data.comportement.filter(v => v && v !== 'aucun')
    : [];
  const maladies          = Array.isArray(data.maladiesDiagnostiquees) ? data.maladiesDiagnostiquees : [];
  const objectifs         = mergeAutre(data.objectif, data.objectifAutre);
  const alimentation      = mergeAutre(data.alimentation, data.alimentationAutre);
  const traitements       = data.traitements && data.traitements.trim() ? data.traitements.trim() : null;
  const comportementTexte = comportementArr.length > 0 ? comportementArr.join(', ') : null;

  const body = {
    user_email:            email,
    prenom_chien:          data.prenom || null,
    race:                  data.race || null,
    poids:                 data.poids ? parseFloat(data.poids) : null,
    age:                   data.age || null,
    sexe:                  data.sexe || null,
    activite:              data.activite || null,
    allergies:             intolerances,
    sensibilites:          sensibilites,
    comportement:          comportementTexte,
    maladies,
    traitements,
    reactions_allergiques: data.reactionsAllergiques || null,
    reaction_statut:       data.reactionStatut || null,
    mode_alimentaire:      data.modeAlimentaire || null,
    alimentation_actuelle: alimentation,
    objectifs,
    ordre,
    actif: true,
  };

  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/chien`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    console.error('Erreur saveChienToSupabase:', response.status, errBody);
  }
  return response;
}

// ── PROMPT RAPPORT ─────────────────────────────────────────
function buildRapportPrompt(data, saison, pm, besoin) {

  // Mapping champs nouveau quiz
  const alimentation    = mergeAutre(data.alimentation, data.alimentationAutre);
  const intolerances    = mergeAutre(data.intolerances, data.intolerancesAutre, ['aucune']);
  const tracas          = mergeAutre(data.tracasQuotidiens, null, ['aucun']);
  const comportement    = Array.isArray(data.comportement) ? data.comportement.filter(v => v && v !== 'aucun') : [];
  const maladies        = Array.isArray(data.maladiesDiagnostiquees) ? data.maladiesDiagnostiquees : [];
  const objectifs       = mergeAutre(data.objectif, data.objectifAutre);
  const coursesOu       = mergeAutre(data.coursesOu, null);
  const reactionsAllerg = data.reactionsAllergiques || 'aucune';
  const traitements     = data.traitements || 'aucun';
  const attentes        = data.attentes || null;

  const nom = data.prenom || 'ton chien';

  return `Tu es Kyno, expert en nutrition canine individualisée basé sur les références NRC 2006 et FEDIAF 2023. Ton ton est chaleureux, expert et direct. Tu tutoies le propriétaire et parles du chien par son prénom "${nom}". Tu ne donnes JAMAIS de quantités en grammes dans ce rapport — uniquement dans le menu séparé.

## PROFIL DE ${nom.toUpperCase()}
- Prénom : ${nom}
- Race : ${data.race || 'non renseigné'}
- Âge : ${data.age || 'non renseigné'}
- Poids : ${data.poids ? data.poids + ' kg' : 'non renseigné'}
- Poids métabolique : ${pm} kg PM
- Sexe / Statut : ${data.sexe || 'non renseigné'}
- Niveau d'activité : ${data.activite || 'non renseigné'}
- Saison actuelle : ${saison}

## SANTÉ
- Alimentation actuelle : ${alimentation.length > 0 ? alimentation.join(', ') : 'non renseigné'}
- Maladies diagnostiquées : ${maladies.length > 0 ? maladies.join(', ') : 'aucune'}
- Traitements en cours : ${traitements}
- Petits tracas quotidiens : ${tracas.length > 0 ? tracas.join(', ') : 'aucun'}
- Réactions allergiques : ${reactionsAllerg}${data.reactionStatut ? ' (' + data.reactionStatut + ')' : ''}
- Intolérances alimentaires : ${intolerances.length > 0 ? intolerances.join(', ') : 'aucune'}
- Comportement alimentaire / caractère : ${comportement.length > 0 ? comportement.join(', ') : 'non renseigné'}

## PROJET
- Mode souhaité : ${data.modeAlimentaire || 'non renseigné'}
- Budget : ${data.budget || 'non renseigné'}
- Équipement disponible : ${Array.isArray(data.equipement) && data.equipement.length > 0 ? data.equipement.join(', ') : 'non renseigné'}
- Temps de préparation : ${data.tempsPrep || 'non renseigné'}
- Lieux de courses : ${coursesOu.length > 0 ? coursesOu.join(', ') : 'non renseigné'}
- Objectif(s) : ${objectifs.length > 0 ? objectifs.join(', ') : 'non renseigné'}
- Attentes libres : ${attentes || 'aucune'}

## BESOIN ÉNERGÉTIQUE
${besoin
  ? `Besoin estimé de ${nom} : **${besoin} kcal/jour** (RER = 70 × ${pm}^0,75 × coefficient activité/statut).`
  : `Calcule le BEE de ${nom} : RER = 70 × ${data.poids || '?'}^0,75, puis applique le coefficient selon l'activité (${data.activite || 'modéré'}).`}
Explique ce chiffre simplement au propriétaire. Ne donne pas de quantités en grammes ici.

## PRÉDISPOSITIONS RACIALES
Identifie les alertes pour "${data.race || 'cette race'}" parmi : DCM/taurine, cuivre, MDR1, obésité, EPI, brachycéphales, épagneul breton (articulations, tendons).
Si aucune prédisposition connue, ne pas inventer.

## AJUSTEMENT SAISONNIER — ${saison.toUpperCase()}
${saison === 'Printemps' ? 'Mue intense : renforcer oméga-3, zinc, biotine. Aliments de saison.' : ''}
${saison === 'Été' ? 'Hydratation prioritaire. Repas aux heures fraîches. Aliments frais et humides.' : ''}
${saison === 'Automne' ? 'Renforcement immunitaire : zinc, oméga-3, probiotiques.' : ''}
${saison === 'Hiver' ? "Adapter les apports caloriques selon l'activité et l'environnement." : ''}

## COMPLÉMENTS PRIORITAIRES
Les 3-5 compléments clés avec dosages selon le poids métabolique (${pm} kg PM).
Rappel : oméga-3 + vitamine E ensemble, CMV obligatoire en ration ménagère.
${tracas.includes('otites') ? `Otites signalées : envisager réduction des sources d'intolérance et apport d'oméga-3.` : ''}
${tracas.includes('selles molles') || tracas.includes('vomissements') ? `Troubles digestifs signalés : adapter les fibres et les sources protéiques.` : ''}
${tracas.includes('pelage terne') || tracas.includes('chute de poils excessive') ? `Problème de pelage signalé : renforcer les apports en oméga-3 et zinc.` : ''}
${tracas.includes('peau irritée') || tracas.includes('démangeaisons') ? `Peau irritée / démangeaisons : surveiller les intolérances et apporter des acides gras essentiels.` : ''}

## LIENS NUTRITION / COMPORTEMENT
${comportement.length > 0 ? `
Comportements signalés : ${comportement.join(', ')}.
Analyse les liens possibles avec l'alimentation (manque de tryptophane, excès de sucres rapides, carence en magnésium…).
Sois concret et pratique.
` : 'Le comportement de ce chien ne nécessite pas d\'ajustements nutritionnels spécifiques.'}

## ALERTES
- Aliments interdits : raisin, oignon/ail/poireau, chocolat, xylitol, os cuits, avocat, macadamia
${intolerances.length > 0 ? `- Intolérances à éviter absolument : ${intolerances.join(', ')}` : ''}
${traitements !== 'aucun' ? `- Traitements en cours (${traitements}) : vérifie les interactions possibles avec l'alimentation.` : ''}
${maladies.length > 0 ? `- Maladies diagnostiquées (${maladies.join(', ')}) : adapter le plan en conséquence et consulter le vétérinaire.` : ''}

## FORMAT DU RAPPORT (600-800 mots)
Structure :
1. Titre accrocheur personnalisé avec le prénom de ${nom}
2. Résumé du profil en 3-4 lignes percutantes
3. BEE calculé et expliqué simplement (sans grammes)
4. Ce qui manque dans son alimentation actuelle (${alimentation.join(', ') || 'non renseigné'})
5. Besoins nutritionnels spécifiques (sans grammes)
6. Alertes raciales si pertinent pour ${data.race || 'cette race'}
7. Ajustement saisonnier ${saison}
8. Liens nutrition/comportement si pertinent
9. Compléments prioritaires avec dosages
10. Aliments à éviter absolument
11. Ce que ça va changer en 4-6 semaines
12. Phrase finale : "Ton menu de la semaine t'attend dans ton espace Kyno."

Note légale : Ce rapport est éducatif et ne remplace pas un avis vétérinaire.`;
}

// ── JWT — email vérifié depuis le header Authorization ─────
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

// ── GÉNÉRATION + ENVOI ─────────────────────────────────────
async function generateAndSend(data) {
  const t0 = Date.now();
  const saison = getSaison();
  const pm = data.poids ? Math.pow(parseFloat(data.poids), 0.75).toFixed(2) : 'à calculer';
  const besoin = besoinKcalJour({
    poids:      data.poids,
    age:        data.age,
    sexe:       data.sexe,
    activite:   data.activite,
    objectifs:  mergeAutre(data.objectif, data.objectifAutre),
    poids_ideal: null,
  });

  const rapportResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: buildRapportPrompt(data, saison, pm, besoin),
      messages: [{ role: 'user', content: 'Génère le rapport nutritionnel.' }]
    })
  });

  if (!rapportResponse.ok) {
    const err = await rapportResponse.json();
    throw new Error(err.error?.message || 'Erreur API Anthropic');
  }

  const rapportResult = await rapportResponse.json();
  const rapport = rapportResult.content[0].text;

  const prenomChien = data.prenom;
  const statut = data.plan === 'beta' ? 'beta' : 'waitlist';
  const ajoutChien = data.ajoutChien === true;

  const ordre = data.email ? await getNextOrdreForEmail(data.email) : 1;

  await Promise.all([
    data.email ? sendEmailRapport(data.email, prenomChien, rapport, data) : Promise.resolve(),
    data.email ? saveChienToSupabase(data.email, data, ordre) : Promise.resolve(),
    (!ajoutChien && data.email) ? saveFoyerToSupabase(data, statut) : Promise.resolve(),
  ]);

  console.log('[generate] durée totale:', Date.now() - t0, 'ms — prenom:', data.prenom, ' —  race:', data.race);
}

// ── ALERTE EMAIL EN CAS D'ÉCHEC BACKGROUND ────────────────
async function sendAlertEmail(prenom, race) {
  const alertDest = process.env.ALERT_EMAIL;
  if (!alertDest) {
    console.warn('[generate] ALERT_EMAIL non défini — alerte email non envoyée');
    return;
  }
  const alertRes = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': process.env.BREVO_API_KEY
    },
    body: JSON.stringify({
      sender: { name: 'Kyno', email: alertDest },
      to: [{ email: alertDest, name: 'Coline' }],
      subject: `Kyno — génération échouée : ${prenom}`,
      htmlContent: `<p>La génération du rapport pour <strong>${prenom}</strong> (${race}) a échoué côté serveur.</p><p>Le profil n'a pas reçu son rapport. Consulte les logs Vercel pour le détail, puis relance manuellement si nécessaire.</p>`
    })
  }).catch(e => { console.error('[generate] alerte send exception:', e.message); return null; });
  if (alertRes && !alertRes.ok) {
    const body = await alertRes.text().catch(() => '');
    console.error('[generate] alerte send erreur:', alertRes.status, body.slice(0, 100));
  }
}

// ── HANDLER PRINCIPAL ──────────────────────────────────────
module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const data = req.body;

  // Validation — retourne l'erreur immédiatement (pas de waitUntil)
  if (!data.prenom || !data.race) {
    return res.status(400).json({ error: 'Données incomplètes — prénom et race requis' });
  }

  // Pour ajoutChien, l'email doit venir du JWT — jamais du corps de la requête.
  if (data.ajoutChien === true) {
    const jwtEmail = getEmailFromJwt(req.headers['authorization']);
    if (!jwtEmail) return res.status(401).json({ error: 'Authentification requise pour ajouter un chien' });
    data.email = jwtEmail;

    // Flux ajout chien : synchrone — le front attend la fin avant de rediriger vers l'espace client
    try {
      await generateAndSend(data);
      return res.status(200).json({ success: true, prenom: data.prenom });
    } catch (error) {
      console.error('Erreur generate.js (ajoutChien):', error);
      return res.status(500).json({ error: 'Erreur serveur', message: error.message });
    }
  }

  // Flux quiz principal : répondre immédiatement, générer en arrière-plan
  res.status(200).json({ success: true, prenom: data.prenom });

  waitUntil(
    generateAndSend(data).catch(async (error) => {
      console.error('[generate] échec waitUntil:', {
        profil: `${data.prenom}/${data.race}`,
        err: error.message,
        stack: error.stack ? error.stack.slice(0, 400) : null
      });
      await sendAlertEmail(data.prenom, data.race);
    })
  );
};

// ── EMAIL RAPPORT ──────────────────────────────────────────
async function sendEmailRapport(email, prenom, rapport, data) {
  const saison = getSaison();
  const pm = data.poids ? Math.pow(parseFloat(data.poids), 0.75).toFixed(2) : null;

  const htmlRapport = rapport
    .replace(/\n\n/g, '</p><p style="margin:0 0 18px;">')
    .replace(/\n/g, '<br>')
    .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#451A36;">$1</strong>')
    .replace(/^/, '<p style="margin:0 0 18px;">')
    .replace(/$/, '</p>');

  const accessUrl = `https://project-jlc6z.vercel.app/acces.html?email=${encodeURIComponent(email)}`;

  const emailRes = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': process.env.BREVO_API_KEY
    },
    body: JSON.stringify({
      sender: { name: 'Kyno', email: 'colinemngl@gmail.com' },
      to: [{ email, name: prenom }],
      subject: `Le rapport nutritionnel de ${prenom} est prêt`,
      htmlContent: buildEmailHtml(prenom, htmlRapport, accessUrl, data)
    })
  });
  if (!emailRes.ok) {
    const errBody = await emailRes.text().catch(() => '');
    throw new Error(`Brevo rapport ${emailRes.status}: ${errBody}`);
  }
}

// ── TEMPLATE EMAIL ─────────────────────────────────────────
function buildEmailHtml(prenom, htmlContent, accessUrl, data = {}) {
  const scoreMatch = (htmlContent || '').match(/score\s*sant[ée]\s*[:=]\s*(\d+)/i)
    || (htmlContent || '').match(/(\d{2,3})\s*\/\s*100/);
  const scoreSante = scoreMatch ? scoreMatch[1] + '/100' : null;

  const scoreRow = scoreSante
    ? `<tr><td style="padding:11px 16px;background:#DDF3F1;font-weight:700;font-size:15px;color:#451A36;font-family:Arial,Helvetica,sans-serif;">Score sant&eacute;&nbsp;&nbsp;&nbsp;<b>${scoreSante}</b></td></tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#FFF4E0;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFF4E0;padding:32px 16px;">
  <tr><td align="center">
  <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#FFFFFF;border:3px solid #451A36;border-radius:20px;overflow:hidden;">

    <tr>
      <td style="padding:0;line-height:0;font-size:0;border-bottom:4px solid #451A36;">
        <img src="${SITE_URL}/email-entete-rapport.png" width="600" height="150" alt="Kyno" style="display:block;width:100%;max-width:600px;">
      </td>
    </tr>

    <tr>
      <td style="padding:30px 32px 26px;">
        <h1 style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:28px;line-height:1.25;font-weight:700;color:#451A36;">
          Le rapport nutritionnel de <span style="display:inline-block;background:#F27A9B;border:3px solid #451A36;border-radius:10px;padding:0 8px 2px;">${prenom}</span> est pr&ecirc;t
        </h1>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#451A36;font-family:Arial,Helvetica,sans-serif;">
          Son profil complet t&apos;attend&nbsp;: ses besoins, son score sant&eacute;, ses menus de la semaine et ses compl&eacute;ments cibl&eacute;s.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:3px solid #451A36;border-radius:16px;overflow:hidden;margin:0 0 20px;">
          ${scoreRow}
          <tr><td style="padding:11px 16px;${scoreSante ? 'border-top:2px solid #E8DCC6;' : 'background:#DDF3F1;font-weight:700;'}font-size:15px;color:#451A36;font-family:Arial,Helvetica,sans-serif;">
            Besoins calcul&eacute;s&nbsp;&nbsp;&nbsp;<b>NRC 2006 et FEDIAF 2023</b>
          </td></tr>
          <tr><td style="padding:11px 16px;border-top:2px solid #E8DCC6;font-size:15px;color:#451A36;font-family:Arial,Helvetica,sans-serif;">
            M&eacute;thode&nbsp;&nbsp;&nbsp;<b>Ration m&eacute;nag&egrave;re individuelle</b>
          </td></tr>
        </table>
        <table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
          <tr>
            <td bgcolor="#E5432F" style="border-radius:999px;border:3px solid #451A36;">
              <a href="${accessUrl}" style="display:inline-block;padding:14px 26px;color:#FFF4E0;font-family:Arial,Helvetica,sans-serif;font-size:17px;font-weight:700;text-decoration:none;white-space:nowrap;">Voir le rapport de ${prenom}</a>
            </td>
          </tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="background:#FCEBC4;border:2px solid #451A36;border-radius:14px;padding:12px 14px;font-size:13px;line-height:1.5;color:#451A36;font-family:Arial,Helvetica,sans-serif;">
              Kyno est un outil &eacute;ducatif et ne remplace pas un avis v&eacute;t&eacute;rinaire. En cas de pathologie ou de traitement en cours, consulte ton v&eacute;t&eacute;rinaire avant tout changement alimentaire.
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <tr>
      <td style="background:#FFF4E0;border-top:3px solid #E8DCC6;padding:16px 32px;font-size:13px;line-height:1.6;color:#6E4A63;font-family:Arial,Helvetica,sans-serif;">
        Kyno &middot; nutrition canine individualis&eacute;e &middot; Lyon, France<br>
        Une question&nbsp;? &Eacute;cris-nous &agrave; <a href="mailto:${CONTACT_EMAIL}" style="color:#451A36;text-decoration:none;">${CONTACT_EMAIL}</a>.
      </td>
    </tr>

  </table>
  </td></tr>
</table>
</body>
</html>`;
}
