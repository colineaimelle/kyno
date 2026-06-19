// api/chat.js

module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'MÃ©thode non autorisÃ©e' });

  try {
    const { messages, profile, email } = req.body;
    if (!messages || !profile) return res.status(400).json({ error: 'DonnÃ©es incomplÃ¨tes' });

    const saison = getSaison();
    const pm = profile.poids ? Math.pow(profile.poids, 0.75).toFixed(2) : 'inconnu';
    const prenomChien = profile.prenom_chien || profile.prenom || 'ton chien';

    // â”€â”€ Prompt systÃ¨me du chat â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const systemPrompt = `Tu es Kyno, expert en nutrition canine individualisÃ©e (NRC 2006, FEDIAF 2023).
Tu suis l'Ã©volution de ${prenomChien} (${profile.race || 'race inconnue'}, ${profile.poids ? profile.poids + ' kg' : 'poids inconnu'}) au fil du temps.
Tu es chaleureux, prÃ©cis et direct. Tu tutoies toujours le propriÃ©taire et parles du chien par son prÃ©nom. Utilise systÃ©matiquement "tu", "ton", "ta", "tes" â€” jamais "vous", "votre", "vos".

Ton rÃ´le dans ce chat :
- Ã‰couter les changements signalÃ©s (selles, appÃ©tit, poids, activitÃ©, comportement, santÃ©)
- Poser des questions pertinentes si tu as besoin de prÃ©cisions
- Adapter tes recommandations nutritionnelles en consÃ©quence
- DÃ©cider si les changements justifient un nouveau menu

RÃˆGLE IMPORTANTE sur [GENERER_MENU] :
- Ajoute [GENERER_MENU] Ã  la toute fin de ta rÃ©ponse UNIQUEMENT si tu gÃ©nÃ¨res effectivement un menu dans ce message
- Ne l'ajoute JAMAIS sur un message de politesse, de remerciement, de confirmation ou de suivi
- Ne l'ajoute JAMAIS si un menu a dÃ©jÃ  Ã©tÃ© gÃ©nÃ©rÃ© plus tÃ´t dans cette conversation (vÃ©rifie l'historique)
- Ne l'ajoute que si les changements sont suffisamment significatifs : changement de poids > 5%, problÃ¨me digestif persistant, changement d'activitÃ© majeur, nouvelle intolÃ©rance suspectÃ©e
- Si tu dis "je gÃ©nÃ¨re le menu" dans ta rÃ©ponse, alors et seulement alors ajoute [GENERER_MENU]
- Pour tout autre message (questions, conseils, remerciements, suivi), rÃ©ponds normalement SANS [GENERER_MENU]

Profil actuel de ${prenomChien} :
- Race : ${profile.race || 'non renseignÃ©e'}
- Poids : ${profile.poids ? profile.poids + ' kg (poids mÃ©tabolique : ' + pm + ' kg PM)' : 'non renseignÃ©'}
- Plan : ${profile.plan || 'beta'}
- Statut : ${profile.statut || 'beta'}
- Saison actuelle : ${saison}`;

    // â”€â”€ Formater l'historique pour l'API Anthropic â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // On s'assure que le premier message est toujours "user"
    const formattedMessages = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));

    // VÃ©rification : l'API Anthropic exige que le premier message soit "user"
    if (formattedMessages.length === 0 || formattedMessages[0].role !== 'user') {
      return res.status(400).json({ error: 'Le premier message doit Ãªtre de l\'utilisateur' });
    }

    // â”€â”€ Appel Ã  Claude â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // â”€â”€ DÃ©tecter si un menu doit Ãªtre gÃ©nÃ©rÃ© â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const menuDemande = reply.includes('[GENERER_MENU]');
    reply = reply.replace('[GENERER_MENU]', '').trim();

    let menuGenere = false;

    if (menuDemande && email) {
      try {
        // Construire les donnÃ©es de profil pour le menu
        // On reconstitue ce que buildMenuPrompt attend Ã  partir
        // des donnÃ©es disponibles dans le profil Supabase
        const menuData = {
          prenom: prenomChien,
          race: profile.race || 'inconnue',
          poids: profile.poids || 0,
          activite: profile.activite || 'modÃ©rÃ©',
          modeAlimentaire: profile.mode_alimentaire || 'ration cuite',
          budget: profile.budget || '30 Ã  60â‚¬',
          equipement: profile.equipement || ['casserole'],
          tempsPrep: profile.temps_prep || '30 min Ã  1h',
          intolerances: profile.intolerances || [],
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
        console.error('Erreur gÃ©nÃ©ration menu:', menuErr);
        // On ne bloque pas la rÃ©ponse chat si le menu Ã©choue
      }
    }

    return res.status(200).json({
      success: true,
      reply,
      menuGenere
    });

  } catch (error) {
    console.error('Erreur chat.js:', error);
    return res.status(500).json({ error: 'Erreur serveur', message: error.message });
  }
};

// â”€â”€ GÃ©nÃ©rer un menu via Claude â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      messages: [{ role: 'user', content: 'GÃ©nÃ¨re le menu de la semaine.' }]
    })
  });

  if (!response.ok) throw new Error('Erreur gÃ©nÃ©ration menu');
  const result = await response.json();
  return result.content[0].text;
}

// â”€â”€ Prompt menu (identique Ã  generate.js) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function buildMenuPrompt(data, saison, pm) {
  const intolerances = mergeAutre(data.intolerances, data.intolerancesAutre, ['aucune']);
  const equipement = Array.isArray(data.equipement) ? data.equipement : [];
  const coursesOu = mergeAutre(data.coursesOu, data.coursesOuAutre);

  return `Tu es Kyno, expert en nutrition canine. Tu gÃ©nÃ¨res des menus hebdomadaires pratiques et rÃ©alistes basÃ©s sur NRC 2006 et FEDIAF 2023.

## PROFIL
- PrÃ©nom : ${data.prenom}
- Race : ${data.race}
- Poids : ${data.poids} kg â€” Poids mÃ©tabolique : ${pm} kg PM
- ActivitÃ© : ${data.activite}
- Saison : ${saison}
- Mode alimentaire : ${data.modeAlimentaire}
- Budget : ${data.budget}
- Ã‰quipement : ${equipement.join(', ')}
- Temps prÃ©paration : ${data.tempsPrep}
- Lieux de courses : ${coursesOu.length > 0 ? coursesOu.join(', ') : 'non renseignÃ©'}
- IntolÃ©rances Ã  exclure absolument : ${intolerances.length > 0 ? intolerances.join(', ') : 'aucune'}

## CONCEPT DU MENU
Le propriÃ©taire cuisine UNE SEULE FOIS par semaine â€” une grande marmite.
- 2 recettes uniquement : une pour le repas du MATIN, une pour le repas du SOIR
- Conservation : jours 1-2-3 au rÃ©frigÃ©rateur, jours 4-5-6-7 au congÃ©lateur en portions

## FORMAT REQUIS

### 1. QUANTITÃ‰ JOURNALIÃˆRE
- Total en grammes par jour pour ${data.prenom}
- RÃ©partition : matin (40%) / soir (60%)

### 2. RECETTE MATIN â€” [nom de la recette]
IngrÃ©dients pour 7 jours (en grammes) :
PrÃ©paration (Ã©tapes simples) :

### 3. RECETTE SOIR â€” [nom de la recette]
MÃªme format que la recette matin.

### 4. SESSION BATCH COOKING
Jour recommandÃ© + durÃ©e estimÃ©e + Ã©tapes dans l'ordre.

### 5. CONDITIONNEMENT
Frigo jours 1-3 / CongÃ©lateur jours 4-7 / DÃ©congÃ©lation la veille.

### 6. LISTE DE COURSES
Viandes & poissons / LÃ©gumes / ComplÃ©ments & huiles / CMV

### 7. COÃ›T ESTIMÃ‰
Total semaine : environ Xâ‚¬

Commence par : "Voici le menu de la semaine de ${data.prenom} !"
Adapte les lÃ©gumes et protÃ©ines Ã  la saison : ${saison}`;
}

// â”€â”€ Envoyer l'email menu via Brevo â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      subject: `Le nouveau menu de ${prenom} est prÃªt âœ¦`,
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
          <p style="margin:6px 0 0;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:rgba(245,240,232,0.35);">Nutrition Canine IndividualisÃ©e</p>
        </td>
      </tr>
      <tr>
        <td style="background:#2FA35E;padding:20px 48px;border-bottom:3px solid #F2843C;">
          <p style="margin:0;font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.7);font-weight:600;">Menu mis Ã  jour</p>
          <p style="margin:4px 0 0;font-size:26px;font-weight:700;color:#FBFDF7;">Le nouveau menu de <em style="font-style:normal;color:#FFCE2E;">${prenom}</em></p>
        </td>
      </tr>
      <tr>
        <td style="background:#FBFDF7;padding:40px 48px 0;">
          <p style="margin:0 0 32px;font-size:14px;color:#7E8C80;line-height:1.8;">Suite Ã  vos Ã©changes avec Kyno, voici le menu adaptÃ© aux changements rÃ©cents de <strong style="color:#2B3A2E;">${prenom}</strong>.</p>
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
        <td style="background:#FBFDF7;padding:0 48px 32px;padding-top:24px;">
          <p style="margin:0;font-size:11px;color:#7E8C80;line-height:1.7;">âš  Ce menu est Ã©ducatif et ne remplace pas un avis vÃ©tÃ©rinaire.</p>
        </td>
      </tr>
      <tr>
        <td style="background:#233028;border-radius:0 0 16px 16px;padding:28px 48px;border-top:3px solid #EC6592;">
          <p style="margin:0;font-size:13px;font-weight:700;color:#FBFDF7;">kyno Â· Lyon, France</p>
          <p style="margin:4px 0 0;font-size:10px;color:rgba(245,240,232,0.2);">Â© 2026 Kyno</p>
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

// â”€â”€ Helper merge â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function mergeAutre(arr, autre, excludeVals = []) {
  const base = Array.isArray(arr) ? arr.filter(v => !excludeVals.includes(v) && v !== 'autre' && v !== 'autres') : [];
  if (autre && autre.trim()) base.push(autre.trim());
  return base;
}

// â”€â”€ Saison â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function getSaison() {
  const m = new Date().getMonth() + 1;
  if (m >= 3 && m <= 5) return 'Printemps';
  if (m >= 6 && m <= 8) return 'Ã‰tÃ©';
  if (m >= 9 && m <= 11) return 'Automne';
  return 'Hiver';
}
