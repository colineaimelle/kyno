// api/chat.js

module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const { messages, profile, email } = req.body;
    if (!messages || !profile) return res.status(400).json({ error: 'Données incomplètes' });

    const saison = getSaison();
    const pm = profile.poids ? Math.pow(profile.poids, 0.75).toFixed(2) : 'inconnu';
    const prenomChien = profile.prenom_chien || profile.prenom || 'ton chien';

    // Déduire le genre à partir du sexe pour les accords grammaticaux
    const sexe = (profile.sexe || '').toLowerCase();
    const estFemelle = sexe.includes('femelle');
    const genre = estFemelle ? 'elle' : 'il';
    const accord = estFemelle ? 'e' : '';

    // Allergies et intolérances depuis le profil Supabase
    const allergies = Array.isArray(profile.allergies) ? profile.allergies : [];
    const allergiesTexte = allergies.length > 0 ? allergies.join(', ') : 'aucune';

    // ── Prompt système du chat ────────────────────────────────────────
    const systemPrompt = `Tu es Kyno, expert en nutrition canine individualisée (NRC 2006, FEDIAF 2023).
Tu suis l'évolution de ${prenomChien} (${profile.race || 'race inconnue'}, ${profile.poids ? profile.poids + ' kg' : 'poids inconnu'}, ${profile.sexe || 'sexe inconnu'}) au fil du temps.
Tu es chaleureux, précis et direct. Tu tutoies toujours le propriétaire et parles du chien par son prénom.
Utilise systématiquement "tu", "ton", "ta", "tes" — jamais "vous", "votre", "vos".

IMPORTANT — Genre de ${prenomChien} : ${profile.sexe || 'non renseigné'}.
${estFemelle ? `C'est une femelle — utilise "elle", "la", "cette chienne" dans tes réponses.` : `C'est un mâle — utilise "il", "le", "ce chien" dans tes réponses.`}

⚠️ ALLERGIES ET INTOLÉRANCES DE ${prenomChien.toUpperCase()} — NE JAMAIS IGNORER :
${allergiesTexte !== 'aucune' ? `${prenomChien} est ALLERGIQUE/INTOLÉRANT(E) à : ${allergiesTexte}
Ces ingrédients sont STRICTEMENT INTERDITS dans toutes tes recommandations et tous les menus.` : 'Aucune allergie ou intolérance connue.'}

Ton rôle dans ce chat :
- Écouter les changements signalés (selles, appétit, poids, activité, comportement, santé)
- Poser des questions pertinentes si tu as besoin de précisions
- Adapter tes recommandations nutritionnelles en conséquence
- Décider si les changements justifient un nouveau menu

RÈGLE IMPORTANTE sur [GENERER_MENU] :
- Ajoute [GENERER_MENU] à la toute fin de ta réponse UNIQUEMENT si tu génères effectivement un menu dans ce message
- Ne l'ajoute JAMAIS sur un message de politesse, de remerciement, de confirmation ou de suivi
- Ne l'ajoute JAMAIS si un menu a déjà été généré plus tôt dans cette conversation
- Ne l'ajoute que si les changements sont suffisamment significatifs : changement de poids > 5%, problème digestif persistant, changement d'activité majeur, nouvelle intolérance suspectée
- Si tu dis "je génère le menu" dans ta réponse, alors et seulement alors ajoute [GENERER_MENU]

Profil actuel de ${prenomChien} :
- Race : ${profile.race || 'non renseignée'}
- Âge : ${profile.age || 'non renseigné'}
- Poids : ${profile.poids ? profile.poids + ' kg (poids métabolique : ' + pm + ' kg PM)' : 'non renseigné'}
- Sexe : ${profile.sexe || 'non renseigné'}
- Activité : ${profile.activite || 'non renseignée'}
- Environnement : ${profile.environnement || 'non renseigné'}
- Antécédents : ${profile.antecedents || 'aucun'}
- Allergies/intolérances : ${allergiesTexte}
- Objectifs : ${Array.isArray(profile.objectifs) ? profile.objectifs.join(', ') : 'non renseignés'}
- Plan : ${profile.plan || 'beta'}
- Saison actuelle : ${saison}`;

    // ── Formater l'historique pour l'API Anthropic ────────────────────
    const formattedMessages = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));

    if (formattedMessages.length === 0 || formattedMessages[0].role !== 'user') {
      return res.status(400).json({ error: "Le premier message doit être de l'utilisateur" });
    }

    // ── Appel à Claude ─────────────────────────────────────────────────
    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        system: systemPrompt,
        messages: formattedMessages
      })
    });

    if (!claudeResponse.ok) {
      const err = await claudeResponse.json();
      throw new Error(err.error?.message || 'Erreur API Anthropic');
    }

    const claudeResult = await claudeResponse.json();
    let reply = claudeResult.content[0].text;

    // ── Détecter si un menu doit être généré ──────────────────────────
    const menuDemande = reply.includes('[GENERER_MENU]');
    reply = reply.replace('[GENERER_MENU]', '').trim();

    let menuGenere = false;

    if (menuDemande && email) {
      try {
        const menuData = {
          prenom: prenomChien,
          race: profile.race || 'inconnue',
          poids: profile.poids || 0,
          activite: profile.activite || 'modéré',
          modeAlimentaire: profile.mode_alimentaire || 'ration cuite',
          budget: profile.budget || '30 à 60€',
          equipement: profile.equipement || ['casserole'],
          tempsPrep: profile.temps_prep || '30 min à 1h',
          intolerances: profile.allergies || [],
          intolerancesAutre: '',
          coursesOu: profile.courses_ou || [],
          coursesOuAutre: ''
        };

        const menu = await genererMenu(menuData, saison, pm);
        if (menu && email) {
          await sendEmailMenu(email, prenomChien, menu);
          menuGenere = true;
        }
      } catch (menuErr) {
        console.error('Erreur génération menu depuis chat:', menuErr);
      }
    }

    return res.status(200).json({ success: true, reply, menuGenere });

  } catch (error) {
    console.error('Erreur chat.js:', error);
    return res.status(500).json({ error: 'Erreur serveur', message: error.message });
  }
};

// ── Générer un menu via Claude ────────────────────────────────────────
async function genererMenu(data, saison, pm) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
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

  if (!response.ok) throw new Error('Erreur génération menu');
  const result = await response.json();
  return result.content[0].text;
}

// ── Prompt menu ───────────────────────────────────────────────────────
function buildMenuPrompt(data, saison, pm) {
  const intolerances = Array.isArray(data.intolerances) ? data.intolerances.filter(v => v !== 'aucune') : [];
  const equipement = Array.isArray(data.equipement) ? data.equipement : [];

  return `Tu es Kyno, expert en nutrition canine. Tu génères des menus hebdomadaires pratiques basés sur NRC 2006 et FEDIAF 2023. Tu tutoies le propriétaire.

⚠️ INTERDICTION ABSOLUE — ALLERGIES DE ${data.prenom.toUpperCase()} :
${intolerances.length > 0 ? `Les ingrédients suivants sont STRICTEMENT INTERDITS dans ce menu : ${intolerances.join(', ')}.
N'utilise AUCUN de ces ingrédients, ni sous forme directe ni dérivée.` : 'Aucune allergie connue.'}

## PROFIL
- Prénom : ${data.prenom}
- Race : ${data.race}
- Poids : ${data.poids} kg — Poids métabolique : ${pm} kg PM
- Activité : ${data.activite}
- Saison : ${saison}
- Mode alimentaire : ${data.modeAlimentaire}
- Budget : ${data.budget}
- Équipement : ${equipement.join(', ') || 'standard'}
- Temps préparation : ${data.tempsPrep}

## CONCEPT DU MENU
Le propriétaire cuisine UNE SEULE FOIS par semaine.
- 2 recettes : une pour le MATIN, une pour le SOIR
- Conservation : jours 1-2-3 au réfrigérateur, jours 4-5-6-7 au congélateur

## FORMAT REQUIS

### 1. QUANTITÉ JOURNALIÈRE
### 2. RECETTE MATIN — [nom]
### 3. RECETTE SOIR — [nom]
### 4. SESSION BATCH COOKING
### 5. CONDITIONNEMENT
### 6. LISTE DE COURSES
### 7. COÛT ESTIMÉ

Commence par : "Voici le menu de la semaine de ${data.prenom} !"
Adapte à la saison : ${saison}
${intolerances.length > 0 ? `RAPPEL FINAL : AUCUN des ingrédients interdits (${intolerances.join(', ')}) ne doit apparaître dans ce menu.` : ''}`;
}

// ── Envoyer l'email menu via Brevo ────────────────────────────────────
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
      subject: `Le nouveau menu de ${prenom} est prêt ✦`,
      htmlContent: `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#E4F4E8;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#E4F4E8;padding:40px 20px;">
    <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
      <tr>
        <td style="background:#2B3A2E;border-radius:16px 16px 0 0;padding:36px 48px;text-align:center;border-bottom:3px solid #EC6592;">
          <p style="margin:0;font-size:24px;font-weight:700;color:#FBFDF7;letter-spacing:0.06em;">kyno</p>
          <p style="margin:6px 0 0;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:rgba(245,240,232,0.35);">Nutrition Canine Individualisée</p>
        </td>
      </tr>
      <tr>
        <td style="background:#2FA35E;padding:20px 48px;border-bottom:3px solid #F2843C;">
          <p style="margin:0;font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.7);font-weight:600;">Menu mis à jour</p>
          <p style="margin:4px 0 0;font-size:26px;font-weight:700;color:#FBFDF7;">Le nouveau menu de <em style="font-style:normal;color:#FFCE2E;">${prenom}</em></p>
        </td>
      </tr>
      <tr>
        <td style="background:#FBFDF7;padding:40px 48px 0;">
          <p style="margin:0 0 32px;font-size:14px;color:#7E8C80;line-height:1.8;">Suite à tes échanges avec Kyno, voici le menu adapté aux changements récents de <strong style="color:#2B3A2E;">${prenom}</strong>.</p>
          <div style="height:3px;background:linear-gradient(to right,#2FA35E,#EC6592,#FFCE2E);margin-bottom:32px;border-radius:2px;"></div>
        </td>
      </tr>
      <tr>
        <td style="background:#FBFDF7;padding:0 48px;">
          <div style="background:white;border-radius:12px;padding:36px;border:1px solid #DDE8DA;border-left:4px solid #EC6592;font-size:14px;line-height:1.85;color:#2B3A2E;">
            ${htmlMenu}
          </div>
        </td>
      </tr>
      <tr>
        <td style="background:#FBFDF7;padding:24px 48px 32px;">
          <p style="margin:0;font-size:11px;color:#7E8C80;line-height:1.7;">⚠ Ce menu est éducatif et ne remplace pas un avis vétérinaire.</p>
        </td>
      </tr>
      <tr>
        <td style="background:#233028;border-radius:0 0 16px 16px;padding:28px 48px;border-top:3px solid #EC6592;">
          <p style="margin:0;font-size:13px;font-weight:700;color:#FBFDF7;">kyno · Lyon, France</p>
          <p style="margin:4px 0 0;font-size:10px;color:rgba(245,240,232,0.2);">© 2026 Kyno</p>
        </td>
      </tr>
    </table>
    </td></tr>
  </table>
</body>
</html>`
    })
  });
}

// ── Helper merge ──────────────────────────────────────────────────────
function mergeAutre(arr, autre, excludeVals = []) {
  const base = Array.isArray(arr) ? arr.filter(v => !excludeVals.includes(v) && v !== 'autre' && v !== 'autres') : [];
  if (autre && autre.trim()) base.push(autre.trim());
  return base;
}

// ── Saison ────────────────────────────────────────────────────────────
function getSaison() {
  const m = new Date().getMonth() + 1;
  if (m >= 3 && m <= 5) return 'Printemps';
  if (m >= 6 && m <= 8) return 'Été';
  if (m >= 9 && m <= 11) return 'Automne';
  return 'Hiver';
}
