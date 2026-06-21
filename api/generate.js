// api/generate.js — v2
// Nouveau parcours : rapport seul → bouton "Accéder à mon espace" → lien magique + menu

// ── SUPABASE ──────────────────────────────────────────────
async function saveToSupabase(data, statut) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/user?on_conflict=email`;

  // Fusion des champs "autre" avec leur liste correspondante
  const intolerances = mergeAutre(data.intolerances, data.intolerancesAutre, ['aucune']);
  const sensibilites = mergeAutre(data.problemesOreilles, data.problemesOreillesAutre, ['non']);
  const comportementParts = [
    ...(Array.isArray(data.comportementAlimentaire) ? data.comportementAlimentaire : []),
    ...mergeAutre(data.troublesComportement, data.troublesComportementAutre, ['aucun'])
  ];
  const environnement = data.environnement === 'autre' && data.environnementAutre
    ? data.environnementAutre
    : data.environnement;
  const antecedentsTexte = data.antecedents && data.antecedents.trim()
    ? data.antecedents.trim()
    : 'Aucun antécédent particulier signalé';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=minimal,resolution=merge-duplicates'
    },
    body: JSON.stringify({
      email: data.email,
      prenom: data.prenom,
      prenom_chien: data.prenom,
      race: data.race,
      poids: data.poids,
      age: data.age,
      sexe: data.sexe,
      plan: data.plan || 'beta',
      statut: statut,
      rapport_envoye: true,
      menu_envoye: false, // le menu sera envoyé après connexion

      // ── Données enrichies du quiz, utilisées par l'espace client ──
      antecedents: antecedentsTexte,
      allergies: intolerances,
      sensibilites: sensibilites,
      activite: data.activite || null,
      environnement: environnement || null,
      comportement: comportementParts.length > 0 ? comportementParts.join(', ') : 'Mange normalement',
      frequence_repas: data.frequenceMenus || null,
      objectifs: mergeAutre(data.objectif, data.objectifAutre)
    })
  });

  // Vérification explicite : sans ça, une erreur Supabase (mauvais type de
  // colonne, contrainte violée, etc.) passe complètement inaperçue.
  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    console.error('Erreur saveToSupabase:', response.status, errBody);
  }

  return response;
}

module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const data = req.body;
    if (!data.prenom || !data.race) return res.status(400).json({ error: 'Données incomplètes' });

    const saison = getSaison();
    const pm = data.poids ? Math.pow(data.poids, 0.75).toFixed(2) : 'à calculer';

    // ── GÉNÉRATION DU RAPPORT UNIQUEMENT ─────────────────
    const rapportResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 4000,
        system: buildRapportPrompt(data, saison, pm),
        messages: [{ role: 'user', content: 'Génère le rapport nutritionnel.' }]
      })
    });

    if (!rapportResponse.ok) {
      const err = await rapportResponse.json();
      throw new Error(err.error?.message || 'Erreur API Anthropic rapport');
    }

    const rapportResult = await rapportResponse.json();
    const rapport = rapportResult.content[0].text;

    // ── SAUVEGARDE SUPABASE + ENVOI EMAIL RAPPORT ────────
    // Les deux en parallèle pour la vitesse
    const prenomChien = data.prenom || 'ton chien';
    const statut = data.plan === 'beta' ? 'beta' : 'waitlist';

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

// ── HELPER : fusionner un tableau de valeurs avec un champ "autre" ──
function mergeAutre(arr, autre, excludeVals = []) {
  const base = Array.isArray(arr) ? arr.filter(v => !excludeVals.includes(v) && v !== 'autre' && v !== 'autres') : [];
  if (autre && autre.trim()) base.push(autre.trim());
  return base;
}

// ── PROMPT RAPPORT ────────────────────────────────────────
function buildRapportPrompt(data, saison, pm) {
  const alimentation = mergeAutre(data.alimentation, data.alimentationAutre);
  const sante = Array.isArray(data.sante) ? data.sante.filter(v => v !== 'aucun') : [];
  const pelage = Array.isArray(data.pelage) ? data.pelage.filter(v => v !== 'brillant') : [];
  const odeurs = Array.isArray(data.odeurs) ? data.odeurs.filter(v => v !== 'aucune') : [];
  const intolerances = mergeAutre(data.intolerances, data.intolerancesAutre, ['aucune']);
  const comportement = mergeAutre(data.troublesComportement, data.troublesComportementAutre, ['aucun']);
  const oreilles = mergeAutre(data.problemesOreilles, data.problemesOreillesAutre, ['non']);
  const environnement = data.environnement === 'autre' && data.environnementAutre ? data.environnementAutre : data.environnement;
  const reactionsAllergiques = data.reactionsAllergiques === 'autre' && data.reactionsAllergiquesAutre ? data.reactionsAllergiquesAutre : data.reactionsAllergiques;
  const objectif = mergeAutre(data.objectif, data.objectifAutre);
  const coursesOu = mergeAutre(data.coursesOu, data.coursesOuAutre);
  const glandesAnales = data.glandesAnales && data.glandesAnales !== 'aucun' ? data.glandesAnales : null;
  const antecedents = data.antecedents && data.antecedents.trim() ? data.antecedents.trim() : null;

  return `Tu es Kyno, expert en nutrition canine individualisée basé sur les références NRC 2006 et FEDIAF 2023. Ton ton est chaleureux, expert et direct. Tu tutoies le propriétaire et parles du chien par son prénom. Tu ne donnes JAMAIS de quantités en grammes dans ce rapport — uniquement dans le menu séparé.

## PROFIL DE ${data.prenom.toUpperCase()}
- Prénom : ${data.prenom}
- Race : ${data.race}
- Âge : ${data.age}
- Poids : ${data.poids ? data.poids + ' kg' : 'non renseigné'}
- Poids métabolique : ${pm} kg PM
- Sexe/Statut : ${data.sexe}
- Niveau d'activité : ${data.activite}
- Environnement : ${environnement}
- Saison actuelle : ${saison}
- Niveau de stress : ${data.stress || 'non renseigné'}

## SANTÉ
- Alimentation actuelle : ${alimentation.length > 0 ? alimentation.join(', ') : 'non renseigné'}
- Antécédents médicaux : ${antecedents || 'aucun antécédent particulier signalé'}
- Problèmes de santé : ${sante.length > 0 ? sante.join(', ') : 'aucun'}
- Traitements : ${data.traitements || 'aucun'}
- Pelage : ${pelage.length > 0 ? pelage.join(', ') : 'bon état'}
- Selles : ${data.selles}
- Odeurs : ${odeurs.length > 0 ? odeurs.join(', ') : 'aucune'}
- Réactions allergiques passées : ${reactionsAllergiques || 'aucune'}
- Intolérances : ${intolerances.length > 0 ? intolerances.join(', ') : 'aucune'}
- Problèmes d'oreilles : ${oreilles.length > 0 ? oreilles.join(', ') : 'aucun'}
- Glandes anales : ${glandesAnales || 'aucun problème signalé'}
- Troubles du comportement : ${comportement.length > 0 ? comportement.join(', ') : 'aucun'}

## PROJET
- Mode souhaité : ${data.modeAlimentaire}
- Budget : ${data.budget}
- Lieux de courses habituels : ${coursesOu.length > 0 ? coursesOu.join(', ') : 'non renseigné'}
- Objectif : ${objectif.length > 0 ? objectif.join(', ') : 'non renseigné'}
- Attentes libres : ${data.attentes || 'aucune'}

## CALCUL BEE
Calcule BEE = 110 × (${data.poids})^0.75 et applique le coefficient selon l'activité.
Exprime le résultat en kcal/jour de façon simple et compréhensible.
Ne donne pas de quantités en grammes ici.

## PRÉDISPOSITIONS RACIALES
Identifie les alertes pour "${data.race}" parmi : DCM/taurine, cuivre, MDR1, obésité, EPI, brachycéphales, épagneul breton (articulations/tendons).
Si aucune prédisposition connue, ne pas inventer.

## AJUSTEMENT SAISONNIER — ${saison.toUpperCase()}
${saison === 'Printemps' ? 'Mue intense : oméga-3, zinc, biotine. Aliments de saison recommandés.' : ''}
${saison === 'Été' ? 'Hydratation prioritaire. Repas aux heures fraîches. Aliments frais et humides.' : ''}
${saison === 'Automne' ? 'Renforcement immunitaire : zinc, oméga-3, probiotiques.' : ''}
${saison === 'Hiver' ? "Adapter les apports selon le niveau d'activité et l'environnement." : ''}

## COMPLÉMENTS PRIORITAIRES
Les 3-5 compléments clés avec dosages selon le poids métabolique.
Rappel : oméga-3 + vitamine E ensemble, CMV obligatoire en ration ménagère.
${glandesAnales ? `Si pertinent, mentionne l'apport en fibres (citrouille, psyllium) pour soutenir la fonction des glandes anales (signalé : ${glandesAnales}).` : ''}

## NUTRITION & COMPORTEMENT
${comportement.length > 0 || data.stress !== 'très calme' ? `
Analyse les liens entre nutrition et comportement pour ce profil.
Troubles déclarés : ${comportement.length > 0 ? comportement.join(', ') : 'aucun'}
Niveau de stress : ${data.stress || 'non renseigné'}
Sois concret et pratique — quels aliments intégrer, lesquels éviter.
` : 'Le comportement de ce chien ne nécessite pas d\'ajustements nutritionnels spécifiques.'}

## ALERTES
- Aliments interdits : raisin, oignon/ail/poireau, chocolat, xylitol, os cuits, avocat, macadamia
- Interactions médicaments si traitements : ${data.traitements || 'aucun'}
${oreilles.length > 0 ? `- Problèmes d'oreilles signalés (${oreilles.join(', ')}) : évoque le lien possible avec une intolérance alimentaire.` : ''}
${antecedents ? `- Antécédents médicaux signalés (${antecedents}) : prends-en compte dans les recommandations.` : ''}

## FORMAT DU RAPPORT (600-800 mots)
Structure :
1. Titre accrocheur personnalisé avec le prénom
2. Résumé du profil en 3-4 lignes percutantes
3. BEE calculé et expliqué simplement (sans grammes)
4. Ce qui manque dans l'alimentation actuelle
5. Besoins nutritionnels spécifiques (sans grammes)
6. Alertes raciales si pertinent
7. Ajustement saisonnier ${saison}
8. Nutrition & comportement (si pertinent)
9. Compléments prioritaires avec dosages
10. Aliments à éviter absolument
11. Ce que ça va changer en 4-6 semaines
12. Phrase finale : "Ton menu de la semaine t'attend dans ton espace Kyno."

Note légale : Ce rapport est éducatif et ne remplace pas un avis vétérinaire.`;
}

// ── EMAIL RAPPORT ─────────────────────────────────────────
async function sendEmailRapport(email, prenom, rapport, data) {
  const htmlRapport = rapport
    .replace(/\n\n/g, '</p><p style="margin:0 0 16px;">')
    .replace(/\n/g, '<br>')
    .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#2B3A2E;font-weight:600;">$1</strong>')
    .replace(/^/, '<p style="margin:0 0 16px;">')
    .replace(/$/, '</p>');

  // URL vers la page d'accès avec l'email pré-rempli
  const accessUrl = `https://project-jlc6z.vercel.app/acces.html?email=${encodeURIComponent(email)}`;

  await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': process.env.BREVO_API_KEY
    },
    body: JSON.stringify({
      sender: { name: 'Kyno', email: 'colinemngl@gmail.com' },
      to: [{ email, name: prenom }],
      subject: `Le rapport nutritionnel de ${prenom} est prêt ✦`,
      htmlContent: buildEmailHtml(prenom, htmlRapport, accessUrl)
    })
  });
}

// ── TEMPLATE EMAIL RAPPORT ────────────────────────────────
function buildEmailHtml(prenom, htmlContent, accessUrl) {
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#E4F4E8;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#E4F4E8;padding:40px 20px;">
    <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">

      <tr>
        <td style="background:#2B3A2E;border-radius:16px 16px 0 0;padding:36px 48px;text-align:center;border-bottom:3px solid #EC6592;">
          <div style="display:inline-block;width:44px;height:44px;border-radius:50%;border:2px solid #2FA35E;text-align:center;line-height:40px;margin-bottom:12px;">
            <span style="font-size:22px;font-weight:700;color:#2FA35E;">K</span>
          </div>
          <p style="margin:0;font-size:24px;font-weight:700;color:#FBFDF7;letter-spacing:0.06em;">kyno</p>
          <p style="margin:6px 0 0;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:rgba(245,240,232,0.35);">Nutrition Canine Individualisée</p>
        </td>
      </tr>

      <tr>
        <td style="background:#2FA35E;padding:20px 48px;border-bottom:3px solid #F2843C;">
          <p style="margin:0;font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.7);font-weight:600;">Rapport personnalisé</p>
          <p style="margin:4px 0 0;font-size:26px;font-weight:700;color:#FBFDF7;">Le rapport nutritionnel de <em style="font-style:normal;color:#FFCE2E;">${prenom}</em> est prêt</p>
        </td>
      </tr>

      <tr>
        <td style="background:#FBFDF7;padding:40px 48px 0;">
          <p style="margin:0 0 8px;font-size:15px;color:#2B3A2E;">Bonjour !</p>
          <p style="margin:0 0 32px;font-size:14px;color:#7E8C80;line-height:1.8;">Voici le rapport nutritionnel ultra-personnalisé que Kyno a généré pour <strong style="color:#2B3A2E;">${prenom}</strong>. Basé sur les références NRC 2006 et FEDIAF 2023.</p>
          <div style="height:3px;background:linear-gradient(to right,#2FA35E,#EC6592,#FFCE2E);margin-bottom:32px;border-radius:2px;"></div>
        </td>
      </tr>

      <tr>
        <td style="background:#FBFDF7;padding:0 48px;">
          <div style="background:white;border-radius:12px;padding:36px;border:1px solid #DDE8DA;border-left:4px solid #2FA35E;font-size:14px;line-height:1.85;color:#2B3A2E;">
            ${htmlContent}
          </div>
        </td>
      </tr>

      <!-- CTA PRINCIPAL : accéder à l'espace + menu -->
      <tr>
        <td style="background:#FBFDF7;padding:32px 48px;">
          <div style="background:#2B3A2E;border-radius:14px;padding:36px;text-align:center;border:3px solid #F2843C;">
            <p style="margin:0 0 6px;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:rgba(245,240,232,0.4);">Prochaine étape</p>
            <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#FBFDF7;line-height:1.3;">Accède à ton espace<br>et découvre le menu de <span style="color:#2FA35E;">${prenom}</span></p>
            <p style="margin:0 0 20px;font-size:13px;color:rgba(245,240,232,0.5);">Ton menu de la semaine t'attend — recettes, quantités et liste de courses.</p>
            <a href="${accessUrl}" style="display:inline-block;background:#2FA35E;color:white;padding:18px 36px;border-radius:4px;text-decoration:none;font-size:15px;font-weight:700;letter-spacing:0.04em;border:2px solid #F2843C;">
              Accéder à mon espace et mon menu →
            </a>
            <p style="margin:14px 0 0;font-size:11px;color:rgba(245,240,232,0.3);">Un lien de connexion sécurisé te sera envoyé automatiquement.</p>
          </div>
        </td>
      </tr>

      <tr>
        <td style="background:#FBFDF7;padding:0 48px 32px;">
          <div style="border-top:1px solid #DDE8DA;padding-top:24px;">
            <p style="margin:0;font-size:11px;color:#7E8C80;line-height:1.7;">⚠ Ce rapport est éducatif et ne remplace pas un avis vétérinaire. En cas de pathologie ou traitement en cours, consulte ton vétérinaire avant tout changement alimentaire.</p>
          </div>
        </td>
      </tr>

      <tr>
        <td style="background:#233028;border-radius:0 0 16px 16px;padding:28px 48px;border-top:3px solid #EC6592;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td>
                <p style="margin:0;font-size:13px;font-weight:700;color:#FBFDF7;letter-spacing:0.04em;">kyno</p>
                <p style="margin:4px 0 0;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:rgba(245,240,232,0.25);">Lyon, France</p>
              </td>
              <td align="right">
                <a href="mailto:colinemngl@gmail.com" style="font-size:11px;color:rgba(245,240,232,0.35);text-decoration:none;">colinemngl@gmail.com</a>
                <p style="margin:4px 0 0;font-size:10px;color:rgba(245,240,232,0.2);">© 2026 Kyno</p>
              </td>
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

// ── SAISON ────────────────────────────────────────────────
function getSaison() {
  const m = new Date().getMonth() + 1;
  if (m >= 3 && m <= 5) return 'Printemps';
  if (m >= 6 && m <= 8) return 'Été';
  if (m >= 9 && m <= 11) return 'Automne';
  return 'Hiver';
}
