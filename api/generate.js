// api/generate.js

// ── SUPABASE ──────────────────────────────────────────────
async function saveToSupabase(data, statut) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/user`;
  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({
      email: data.email,
      prenom: data.prenom,
      prenom_chien: data.prenom,
      race: data.race,
      poids: data.poids,
      plan: data.plan || 'beta',
      statut: statut,
      rapport_envoye: true,
      menu_envoye: statut === 'beta'
    })
  });
}

export default async function handler(req, res) {
  // ... reste du code
export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const data = req.body;
    if (!data.prenom || !data.race) return res.status(400).json({ error: 'Données incomplètes' });

    const plan = data.plan || 'beta';
    const saison = getSaison();
    const pm = data.poids ? Math.pow(data.poids, 0.75).toFixed(2) : 'à calculer';

    // ── APPEL 1 : RAPPORT ────────────────────────────────
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

    // ── EMAIL 1 : RAPPORT ────────────────────────────────
    if (data.email) {
      await sendEmailRapport(data.email, data.prenom, rapport);
    }

    // ── APPEL 2 : MENU (bêta uniquement) ─────────────────
    if (plan === 'beta' && data.email) {
      const menuResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 4000,
          system: buildMenuPrompt(data, saison, pm),
          messages: [{ role: 'user', content: 'Génère le menu de la semaine.' }]
        })
      });

      if (menuResponse.ok) {
        const menuResult = await menuResponse.json();
        const menu = menuResult.content[0].text;
        await sendEmailMenu(data.email, data.prenom, menu);
      }
    }

    // ── SAUVEGARDE SUPABASE ───────────────────────────────────
    if (data.email) {
      const statut = data.plan === 'beta' ? 'beta' : 'waitlist';
      await saveToSupabase(data, statut);
    }
    return res.status(200).json({ success: true, prenom: data.prenom });

  } catch (error) {
    console.error('Erreur generate.js:', error);
    return res.status(500).json({ error: 'Erreur serveur', message: error.message });
  }
}

// ── PROMPT RAPPORT ────────────────────────────────────────
function buildRapportPrompt(data, saison, pm) {
  const sante = Array.isArray(data.sante) ? data.sante.filter(v => v !== 'aucun') : [];
  const pelage = Array.isArray(data.pelage) ? data.pelage.filter(v => v !== 'brillant') : [];
  const odeurs = Array.isArray(data.odeurs) ? data.odeurs.filter(v => v !== 'aucune') : [];
  const intolerances = Array.isArray(data.intolerances) ? data.intolerances.filter(v => v !== 'aucune') : [];
  const comportement = Array.isArray(data.troublesComportement) ? data.troublesComportement.filter(v => v !== 'aucun') : [];

  return `Tu es Kyno, expert en nutrition canine individualisée basé sur les références NRC 2006 et FEDIAF 2023. Ton ton est chaleureux, expert et direct. Tu vouvoies le propriétaire et parles du chien par son prénom. Tu ne donnes JAMAIS de quantités en grammes dans ce rapport — uniquement dans le menu séparé.

## PROFIL DE ${data.prenom.toUpperCase()}
- Prénom : ${data.prenom}
- Race : ${data.race}
- Âge : ${data.age}
- Poids : ${data.poids ? data.poids + ' kg' : 'non renseigné'}
- Poids métabolique : ${pm} kg PM
- Sexe/Statut : ${data.sexe}
- Niveau d'activité : ${data.activite}
- Environnement : ${data.environnement}
- Saison actuelle : ${saison}
- Niveau de stress : ${data.stress || 'non renseigné'}

## SANTÉ
- Alimentation actuelle : ${data.alimentation}
- Problèmes de santé : ${sante.length > 0 ? sante.join(', ') : 'aucun'}
- Traitements : ${data.traitements || 'aucun'}
- Pelage : ${pelage.length > 0 ? pelage.join(', ') : 'bon état'}
- Selles : ${data.selles}
- Odeurs : ${odeurs.length > 0 ? odeurs.join(', ') : 'aucune'}
- Intolérances : ${intolerances.length > 0 ? intolerances.join(', ') : 'aucune'}
- Troubles du comportement : ${comportement.length > 0 ? comportement.join(', ') : 'aucun'}

## PROJET
- Mode souhaité : ${data.modeAlimentaire}
- Budget : ${data.budget}
- Objectif : ${data.objectif}
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
${saison === 'Hiver' ? 'Adapter les apports selon le niveau d\'activité et l\'environnement.' : ''}

## COMPLÉMENTS PRIORITAIRES
Les 3-5 compléments clés avec dosages selon le poids métabolique.
Rappel : oméga-3 + vitamine E ensemble, CMV obligatoire en ration ménagère.

## NUTRITION & COMPORTEMENT
${comportement.length > 0 || data.stress !== 'très calme' ? `
Analyse les liens entre nutrition et comportement pour ce profil :
- Troubles déclarés : ${comportement.length > 0 ? comportement.join(', ') : 'aucun'}
- Niveau de stress : ${data.stress || 'non renseigné'}

Explique quels aliments et compléments peuvent agir positivement sur :
- L'anxiété et le stress : tryptophane (dinde, œuf), magnésium, oméga-3, probiotiques
- L'hyperactivité : réduire les glucides rapides, augmenter les protéines de qualité, magnésium
- L'agressivité : oméga-3 DHA (action sur le système nerveux), tryptophane
- Les peurs : vitamine B6, magnésium, ashwagandha (si adapté au chien)
Sois concret et pratique — quels aliments intégrer, lesquels éviter.
` : 'Le comportement de ce chien ne nécessite pas d\'ajustements nutritionnels spécifiques.'}

## ALERTES
- Aliments interdits : raisin, oignon/ail/poireau, chocolat, xylitol, os cuits, avocat, macadamia
- Interactions médicaments si traitements : ${data.traitements || 'aucun'}
- Signaux d'alerte vétérinaire pertinents pour ce profil

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
12. Phrase finale : "Votre menu de la semaine arrive dans quelques instants."

Note légale : Ce rapport est éducatif et ne remplace pas un avis vétérinaire.`;
}

// ── PROMPT MENU ───────────────────────────────────────────
function buildMenuPrompt(data, saison, pm) {
  const intolerances = Array.isArray(data.intolerances) ? data.intolerances.filter(v => v !== 'aucune') : [];
  const equipement = Array.isArray(data.equipement) ? data.equipement : [];

  return `Tu es Kyno, expert en nutrition canine. Tu génères des menus hebdomadaires pratiques et réalistes basés sur NRC 2006 et FEDIAF 2023.

## PROFIL
- Prénom : ${data.prenom}
- Race : ${data.race}
- Poids : ${data.poids} kg — Poids métabolique : ${pm} kg PM
- Activité : ${data.activite}
- Saison : ${saison}
- Mode alimentaire : ${data.modeAlimentaire}
- Budget : ${data.budget}
- Équipement : ${equipement.join(', ')}
- Temps préparation : ${data.tempsPrep}
- Intolérances à exclure absolument : ${intolerances.length > 0 ? intolerances.join(', ') : 'aucune'}

## CONCEPT DU MENU
Le propriétaire cuisine UNE SEULE FOIS par semaine — une grande marmite.
- 2 recettes uniquement : une pour le repas du MATIN, une pour le repas du SOIR
- Les recettes sont cuisinées en grande quantité pour toute la semaine
- Conservation : jours 1-2-3 au réfrigérateur, jours 4-5-6-7 au congélateur en portions
- Les portions sont décongelées la veille au frigo

## FORMAT REQUIS

### 1. QUANTITÉ JOURNALIÈRE
- Total en grammes par jour pour ${data.prenom}
- Répartition : matin (40%) / soir (60%)

### 2. RECETTE MATIN — [nom de la recette]
Ingrédients pour 7 jours au total (en grammes) :
- Protéine principale : X g
- Légume 1 : X g
- Légume 2 : X g
- Complément : X g
- Huile oméga-3 : X ml (à ajouter FROIDE dans la gamelle, jamais chauffée)

Préparation (étapes simples) :
1. ...
2. ...
3. ...

### 3. RECETTE SOIR — [nom de la recette]
Même format que la recette matin.

### 4. SESSION BATCH COOKING
Jour recommandé : dimanche (ou autre)
Durée estimée : X minutes
Étapes dans l'ordre :
1. ...
2. ...

### 5. CONDITIONNEMENT
- Portions jours 1-2-3 → réfrigérateur (boîtes hermétiques)
- Portions jours 4-5-6-7 → congélateur (sachets ou boîtes)
- Décongélation : la veille au soir au réfrigérateur
- Ne jamais réchauffer au micro-ondes — tiède à l'eau chaude

### 6. LISTE DE COURSES
Viandes & poissons :
- ...
Légumes :
- ...
Compléments & huiles :
- ...
CMV : Vit'i5 ou équivalent — dosage selon le poids de ${data.prenom}

### 7. COÛT ESTIMÉ
Total semaine : environ X€ (adapté au budget ${data.budget})

Commence par : "Voici le menu de la semaine de ${data.prenom} !"
Intolérances à exclure : ${intolerances.length > 0 ? intolerances.join(', ') : 'aucune'}
Adapte les légumes et protéines à la saison : ${saison}`;
}

// ── EMAIL RAPPORT ─────────────────────────────────────────
async function sendEmailRapport(email, prenom, rapport) {
  const htmlRapport = rapport
    .replace(/\n\n/g, '</p><p style="margin:0 0 16px;">')
    .replace(/\n/g, '<br>')
    .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#2B3A2E;font-weight:600;">$1</strong>')
    .replace(/^/, '<p style="margin:0 0 16px;">')
    .replace(/$/, '</p>');

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
      htmlContent: buildEmailHtml(prenom, htmlRapport, 'rapport')
    })
  });
}

// ── EMAIL MENU ────────────────────────────────────────────
async function sendEmailMenu(email, prenom, menu) {
  const htmlMenu = menu
    .replace(/\n\n/g, '</p><p style="margin:0 0 16px;">')
    .replace(/\n/g, '<br>')
    .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#2B3A2E;font-weight:600;">$1</strong>')
    .replace(/^/, '<p style="margin:0 0 16px;">')
    .replace(/$/, '</p>');

  await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': process.env.BREVO_API_KEY
    },
    body: JSON.stringify({
      sender: { name: 'Kyno', email: 'colinemngl@gmail.com' },
      to: [{ email, name: prenom }],
      subject: `Le menu de la semaine de ${prenom} ✦`,
      htmlContent: buildEmailHtml(prenom, htmlMenu, 'menu')
    })
  });
}

// ── TEMPLATE EMAIL ────────────────────────────────────────
function buildEmailHtml(prenom, htmlContent, type) {
  const isMenu = type === 'menu';
  const title = isMenu
    ? `Le menu de la semaine de <em style="font-style:normal;color:#FFCE2E;">${prenom}</em>`
    : `Le rapport nutritionnel de <em style="font-style:normal;color:#FFCE2E;">${prenom}</em> est prêt`;
  const subtitle = isMenu
    ? 'Menu personnalisé — semaine 1'
    : 'Rapport personnalisé';
  const intro = isMenu
    ? `Voici le menu détaillé de la première semaine pour <strong style="color:#2B3A2E;">${prenom}</strong>. Quantités précises, batch cooking et liste de courses inclus.`
    : `Voici le rapport nutritionnel ultra-personnalisé que Kyno a généré pour <strong style="color:#2B3A2E;">${prenom}</strong>. Basé sur les références NRC 2006 et FEDIAF 2023.`;
  const ctaText = isMenu
    ? `Continuer avec Kyno — menus chaque mois →`
    : `Voir le menu de la semaine dans le prochain email`;

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
          <p style="margin:0;font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.7);font-weight:600;">${subtitle}</p>
          <p style="margin:4px 0 0;font-size:26px;font-weight:700;color:#FBFDF7;">${title}</p>
        </td>
      </tr>

      <tr>
        <td style="background:#FBFDF7;padding:40px 48px 0;">
          <p style="margin:0 0 8px;font-size:15px;color:#2B3A2E;">Bonjour,</p>
          <p style="margin:0 0 32px;font-size:14px;color:#7E8C80;line-height:1.8;">${intro}</p>
          <div style="height:3px;background:linear-gradient(to right,#2FA35E,#EC6592,#FFCE2E);margin-bottom:32px;border-radius:2px;"></div>
        </td>
      </tr>

      <tr>
        <td style="background:#FBFDF7;padding:0 48px;">
          <div style="background:white;border-radius:12px;padding:36px;border:1px solid #DDE8DA;border-left:4px solid ${isMenu ? '#EC6592' : '#2FA35E'};font-size:14px;line-height:1.85;color:#2B3A2E;">
            ${htmlContent}
          </div>
        </td>
      </tr>

      <tr>
        <td style="background:#FBFDF7;padding:32px 48px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td width="33%" style="padding:0 6px 0 0;text-align:center;">
                <div style="background:#E4F4E8;border-radius:10px;padding:16px 12px;">
                  <p style="margin:0;font-size:20px;font-weight:700;color:#2FA35E;">NRC</p>
                  <p style="margin:4px 0 0;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#7E8C80;">Références</p>
                </div>
              </td>
              <td width="33%" style="padding:0 3px;text-align:center;">
                <div style="background:#FBE2EB;border-radius:10px;padding:16px 12px;">
                  <p style="margin:0;font-size:20px;font-weight:700;color:#EC6592;">100%</p>
                  <p style="margin:4px 0 0;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#7E8C80;">Personnalisé</p>
                </div>
              </td>
              <td width="33%" style="padding:0 0 0 6px;text-align:center;">
                <div style="background:#FFF1BF;border-radius:10px;padding:16px 12px;">
                  <p style="margin:0;font-size:20px;font-weight:700;color:#2B3A2E;">12×</p>
                  <p style="margin:4px 0 0;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#7E8C80;">Menus / an</p>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <tr>
        <td style="background:#FBFDF7;padding:0 48px 40px;">
          <div style="background:#2B3A2E;border-radius:14px;padding:36px;text-align:center;border:3px solid #F2843C;">
            <p style="margin:0 0 6px;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:rgba(245,240,232,0.4);">Chaque mois</p>
            <p style="margin:0 0 16px;font-size:20px;font-weight:700;color:#FBFDF7;line-height:1.3;">Un nouveau menu pour <span style="color:#2FA35E;">${prenom}</span><br><span style="font-size:14px;font-weight:400;color:rgba(245,240,232,0.5);">adapté à la saison et à son évolution</span></p>
            <a href="https://project-jlc6z.vercel.app" style="display:inline-block;background:#2FA35E;color:white;padding:16px 32px;border-radius:4px;text-decoration:none;font-size:13px;font-weight:700;letter-spacing:0.04em;border:2px solid #F2843C;">${ctaText}</a>
          </div>
        </td>
      </tr>

      <tr>
        <td style="background:#FBFDF7;padding:0 48px 32px;">
          <div style="border-top:1px solid #DDE8DA;padding-top:24px;">
            <p style="margin:0;font-size:11px;color:#7E8C80;line-height:1.7;">⚠ Ce rapport est éducatif et ne remplace pas un avis vétérinaire. En cas de pathologie ou traitement en cours, consultez votre vétérinaire avant tout changement alimentaire.</p>
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
