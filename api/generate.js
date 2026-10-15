// api/generate.js — v4
// Aligné avec le nouveau quiz 22 questions (jour d'envoi ajouté)
// Champs quiz → Supabase → espace client

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

// ── SUPABASE ───────────────────────────────────────────────
async function saveToSupabase(data, statut) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/user?on_conflict=email`;

  // ── Mapping nouveau quiz → colonnes Supabase ──────────────

  // Intolérances alimentaires (Q12)
  const intolerances = mergeAutre(data.intolerances, data.intolerancesAutre, ['aucune']);

  // Sensibilités / tracas quotidiens (Q10)
  const sensibilites = mergeAutre(data.tracasQuotidiens, null, ['aucun']);

  // Comportement (Q13)
  const comportement = Array.isArray(data.comportement)
    ? data.comportement.filter(v => v && v !== 'aucun')
    : [];

  // Maladies diagnostiquées (Q8)
  const maladies = data.maladiesDiagnostiquees && Array.isArray(data.maladiesDiagnostiquees)
    ? data.maladiesDiagnostiquees
    : [];

  // Objectifs (Q19)
  const objectifs = mergeAutre(data.objectif, data.objectifAutre);

  // Alimentation actuelle (Q7)
  const alimentation = mergeAutre(data.alimentation, data.alimentationAutre);

  // Lieux de courses (Q18)
  const coursesOu = mergeAutre(data.coursesOu, null);

  // Réactions allergiques (Q11)
  const reactionsAllergiques = data.reactionsAllergiques || null;
  const reactionStatut = data.reactionStatut || null;

  // Attentes libres (Q20)
  const attentes = data.attentes && data.attentes.trim() ? data.attentes.trim() : null;

  // Traitements (Q9)
  const traitements = data.traitements && data.traitements.trim() ? data.traitements.trim() : null;

  // Comportement texte agrégé pour affichage
  const comportementTexte = comportement.length > 0 ? comportement.join(', ') : null;

  const body = {
    email:                   data.email,
    prenom_chien:            data.prenom || null,
    race:                    data.race || null,
    poids:                   data.poids ? parseFloat(data.poids) : null,
    age:                     data.age || null,
    sexe:                    data.sexe || null,
    activite:                data.activite || null,
    plan:                    data.plan || 'beta',
    statut:                  statut,
    rapport_envoye:          true,
    menu_envoye:             false,

    // Santé
    allergies:               intolerances,          // Q12
    sensibilites:            sensibilites,          // Q10 (tracas quotidiens)
    comportement:            comportementTexte,     // Q13
    maladies:                maladies,              // Q8
    traitements:             traitements,           // Q9
    reactions_allergiques:   reactionsAllergiques,  // Q11
    reaction_statut:         reactionStatut,        // Q11 statut

    // Projet
    mode_alimentaire:        data.modeAlimentaire || null,   // Q14
    // budget omis — colonne absente du schéma Supabase (PGRST204)
    equipement:              Array.isArray(data.equipement) ? data.equipement : [], // Q16
    temps_prep:              data.tempsPrep || null,         // Q17
    courses_ou:              coursesOu,                      // Q18
    objectifs:               objectifs,                      // Q19
    attentes:                attentes,                       // Q20

    // Données contextuelles
    alimentation_actuelle:   alimentation,

    // Préférences d'envoi (Q21 — entier 1-7, 1=lundi par défaut)
    jour_envoi: (Number.isInteger(data.jourEnvoi) && data.jourEnvoi >= 1 && data.jourEnvoi <= 7)
      ? data.jourEnvoi
      : (Number.isInteger(parseInt(data.jourEnvoi)) && parseInt(data.jourEnvoi) >= 1 && parseInt(data.jourEnvoi) <= 7)
        ? parseInt(data.jourEnvoi)
        : 1,
  };

  const response = await fetch(url, {
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
    console.error('Erreur saveToSupabase:', response.status, errBody);
  }

  return response;
}

// ── PROMPT RAPPORT ─────────────────────────────────────────
function buildRapportPrompt(data, saison, pm) {

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

## CALCUL BEE
Calcule BEE = 110 × (${data.poids || '?'})^0.75 et applique le coefficient selon l'activité (${data.activite || 'modéré'}).
Exprime le résultat en kcal/jour de façon simple. Ne donne pas de quantités en grammes ici.

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

// ── HANDLER PRINCIPAL ──────────────────────────────────────
module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const data = req.body;
    if (!data.prenom || !data.race) {
      return res.status(400).json({ error: 'Données incomplètes — prénom et race requis' });
    }

    const saison = getSaison();
    const pm = data.poids ? Math.pow(parseFloat(data.poids), 0.75).toFixed(2) : 'à calculer';

    // ── Génération du rapport ──────────────────────────────
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
        system: buildRapportPrompt(data, saison, pm),
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

    // ── Sauvegarde + email en parallèle ───────────────────
    await Promise.all([
      data.email ? sendEmailRapport(data.email, prenomChien, rapport, data) : Promise.resolve(),
      data.email ? saveToSupabase(data, statut) : Promise.resolve()
    ]);

    return res.status(200).json({ success: true, prenom: prenomChien });

  } catch (error) {
    console.error('Erreur generate.js:', error);
    return res.status(500).json({ error: 'Erreur serveur', message: error.message });
  }
};

// ── EMAIL RAPPORT ──────────────────────────────────────────
async function sendEmailRapport(email, prenom, rapport, data) {
  const saison = getSaison();
  const pm = data.poids ? Math.pow(parseFloat(data.poids), 0.75).toFixed(2) : null;

  const htmlRapport = rapport
    .replace(/\n\n/g, '</p><p style="margin:0 0 18px;">')
    .replace(/\n/g, '<br>')
    .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#2B3A2E;">$1</strong>')
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
      subject: `Le rapport nutritionnel de ${prenom} est prêt ✦`,
      htmlContent: buildEmailHtml(prenom, htmlRapport, accessUrl, data, saison)
    })
  });
  if (!emailRes.ok) {
    const errBody = await emailRes.text().catch(() => '');
    throw new Error(`Brevo rapport ${emailRes.status}: ${errBody}`);
  }
}

// ── TEMPLATE EMAIL ─────────────────────────────────────────
function buildEmailHtml(prenom, htmlContent, accessUrl, data = {}, saison = '') {
  const race = data.race || 'non renseigné';
  const age = data.age || '';
  const poids = data.poids ? data.poids + ' kg' : '';
  const sousTitre = [race, age, poids].filter(Boolean).join(' · ');

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
                <span style="display:inline-block;background:#FBE4D8;color:#C85A2C;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:6px 12px;border-radius:20px;">${saison}</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <tr>
        <td style="background:#2B3A2E;padding:24px 32px;">
          <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:#7FBE98;font-weight:700;">Rapport nutritionnel</p>
          <p style="margin:0;font-size:21px;font-weight:700;color:#FBFDF7;line-height:1.3;">Le profil complet de ${prenom} est prêt</p>
        </td>
      </tr>

      <tr>
        <td style="background:#FFFFFF;padding:32px 32px 8px;border:1px solid #E3EDE1;border-top:none;">
          <div style="font-size:14.5px;color:#3C473D;line-height:1.9;">
            ${htmlContent}
          </div>
        </td>
      </tr>

      <tr>
        <td style="background:#FFFFFF;padding:8px 32px 36px;border:1px solid #E3EDE1;border-top:none;border-radius:0 0 20px 20px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #EDF2EA;">
            <tr><td style="padding-top:28px;text-align:center;">
              <a href="${accessUrl}" style="display:inline-block;background:#2FA35E;color:white;padding:14px 30px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:700;">Accéder à l'espace de ${prenom} →</a>
            </td></tr>
          </table>
        </td>
      </tr>

      <tr>
        <td style="padding:24px 32px 0;">
          <p style="margin:0 0 12px;font-size:11px;color:#9AA69B;line-height:1.7;">⚠ Ce rapport est éducatif et ne remplace pas un avis vétérinaire. En cas de pathologie ou traitement en cours, consulte ton vétérinaire avant tout changement alimentaire.</p>
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
