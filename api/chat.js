// api/chat.js — v3
// 1 seule recette par menu (donnée matin et soir)

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
    const nom = profile.prenom_chien || profile.prenom || 'ton chien';

    const sexe = (profile.sexe || '').toLowerCase();
    const estFemelle = sexe.includes('femelle');
    const allergies = Array.isArray(profile.allergies) ? profile.allergies : [];

    const recettesActuelles = Array.isArray(profile.recettes) && profile.recettes.length > 0
      ? profile.recettes.map(r => `- ${r.moment} : ${r.titre} (${r.ration}g/repas)`).join('\n')
      : 'Aucun menu actif pour le moment.';

    const systemPrompt = `Tu es Kyno, expert en nutrition canine individualisée (NRC 2006, FEDIAF 2023).
Tu suis l'évolution de ${nom} (${profile.race || 'race inconnue'}, ${profile.poids ? profile.poids + ' kg' : 'poids inconnu'}, ${profile.sexe || 'sexe inconnu'}).
Tu es chaleureux, précis et direct. Tu tutoies toujours le propriétaire et parles du chien par son prénom.
Genre de ${nom} : ${profile.sexe || 'non renseigné'} — ${estFemelle ? 'utilise "elle", "la", "cette chienne".' : 'utilise "il", "le", "ce chien".'}

⚠️ ALLERGIES ET INTOLÉRANCES — INTERDICTION ABSOLUE :
${allergies.length > 0
  ? `${nom} est ALLERGIQUE/INTOLÉRANT(E) à : ${allergies.join(', ')}
Ces ingrédients sont STRICTEMENT INTERDITS dans toutes tes recommandations et tous les menus que tu génères.`
  : 'Aucune allergie ou intolérance connue.'}

MENU ACTUEL DE ${nom.toUpperCase()} :
${recettesActuelles}

PROFIL COMPLET :
- Race : ${profile.race || 'non renseignée'}
- Âge : ${profile.age || 'non renseigné'}
- Poids : ${profile.poids ? profile.poids + ' kg (PM : ' + pm + ' kg)' : 'non renseigné'}
- Sexe : ${profile.sexe || 'non renseigné'}
- Activité : ${profile.activite || 'non renseignée'}
- Environnement : ${profile.environnement || 'non renseigné'}
- Antécédents : ${profile.antecedents || 'aucun'}
- Objectifs : ${Array.isArray(profile.objectifs) ? profile.objectifs.join(', ') : 'non renseignés'}
- Saison actuelle : ${saison}

─────────────────────────────────────────────────
FORMAT DE RÉPONSE OBLIGATOIRE — JSON STRICT
─────────────────────────────────────────────────
Tu réponds TOUJOURS avec ce JSON exact, sans texte avant ni après, sans balises markdown :

{
  "reply": "ta réponse au propriétaire, en texte naturel. Utilise **texte** pour le gras.",
  "updates": {
    // Uniquement les champs CONFIRMÉS à mettre à jour, vide {} si rien ne change.
    // Champs modifiables : poids (number), allergies (array — nouvelles allergies SEULEMENT),
    // sensibilites (array), objectifs (array), activite (string), comportement (string), antecedents (string), score_sante (number)
  },
  "observations": [
    // Observations informelles sur l'état de ${nom} mentionnées dans ce message du propriétaire.
    // Ex: [{ "texte": "mange mieux depuis 3 jours" }, { "texte": "poils plus brillants" }]
    // [] si aucune observation informelle dans ce message.
  ],
  "generer_menu": false
}

RÈGLES SUR observations :
- Extrais les informations informelles sur l'état de ${nom} mentionnées par le propriétaire, sans confirmation formelle
- Exemples valides : "mange mieux", "moins d'énergie", "poils plus brillants", "dort plus", "boit davantage", "a vomi", "selles molles", etc.
- Ne pas dupliquer ce qui va dans "updates" (les mises à jour formelles confirmées)
- Tableau vide [] si aucune observation dans ce message

RÈGLES DE MISE À JOUR DU PROFIL :
- Si le propriétaire mentionne un changement (poids, nouvelle allergie, activité, etc.), demande TOUJOURS confirmation avant de mettre à jour : "Je note X, je mets à jour la fiche de ${nom} ?"
- Mets "updates": {} tant que le propriétaire n'a pas confirmé explicitement
- Quand le propriétaire confirme ("oui", "exactement", "c'est ça", etc.), remplis "updates" avec les valeurs confirmées

CHAMPS VERROUILLÉS — REFUS POLI :
- Si le propriétaire demande à modifier race, sexe, age, prenom_chien ou email, réponds : "Ces informations ne peuvent être modifiées que par notre support technique à colinemngl@gmail.com."
- Ne mets JAMAIS ces champs dans "updates"

RÈGLES SUR generer_menu :
- true si : demande explicite de mise à jour/génération du menu, nouvelle allergie confirmée, changement de poids > 5%, problème digestif persistant, changement d'activité majeur
- false pour tout le reste (questions de suivi, encouragements, premier message)
- Ne mets JAMAIS true deux fois dans la même conversation sauf si la première génération a eu lieu il y a plus de 7 messages

CAPACITÉS : Tu ES capable de générer et mettre à jour le menu de ${nom} directement dans son espace client. Quand quelqu'un te demande de mettre à jour le menu ou de le générer, tu réponds positivement, tu annonces ce que tu vas faire, et tu mets generer_menu à true. Ne dis JAMAIS que tu n'as pas accès à l'espace client — tu y as accès via la génération de menu.`;

    const formattedMessages = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));

    if (!formattedMessages.length || formattedMessages[0].role !== 'user') {
      return res.status(400).json({ error: "Le premier message doit être de l'utilisateur" });
    }

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1200,
        system: systemPrompt,
        messages: formattedMessages
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.json().catch(() => ({}));
      throw new Error(err.error?.message || 'Erreur API Anthropic');
    }

    const claudeResult = await claudeRes.json();
    let rawText = claudeResult.content[0].text.trim();
    rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
    const first = rawText.indexOf('{');
    const last = rawText.lastIndexOf('}');
    if (first > 0 || last < rawText.length - 1) rawText = rawText.slice(first, last + 1);

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      console.error('Parsing JSON réponse chat échoué:', e.message);
      return res.status(200).json({ success: true, reply: rawText, menuGenere: false });
    }

    const reply = parsed.reply || '';
    const updates = parsed.updates || {};
    const genererMenu = parsed.generer_menu === true;
    const newObservations = Array.isArray(parsed.observations) ? parsed.observations : [];

    if (email && Object.keys(updates).length > 0) {
      const patch = { ...updates };
      if (Array.isArray(updates.allergies) && updates.allergies.length > 0) {
        const merged = [...new Set([...allergies, ...updates.allergies])];
        patch.allergies = merged;
      }
      // Mise à jour poids_historique seulement si le poids a réellement changé
      if (updates.poids != null && updates.poids !== profile.poids) {
        const existingPoids = Array.isArray(profile.poids_historique) ? profile.poids_historique : [];
        const today = new Date().toISOString().split('T')[0];
        patch.poids_historique = [...existingPoids, { label: today, poids: updates.poids }].slice(-6);
      }
      await patchSupabase(email, patch);
      Object.assign(profile, patch);
    }

    if (email) {
      const updatedHistory = [...messages, { role: 'assistant', content: reply }];
      await saveChatHistory(email, updatedHistory);
    }

    if (email && newObservations.length > 0) {
      await saveObservations(email, newObservations);
    }

    let menuGenere = false;
    if (genererMenu && email) {
      try {
        const updatedPm = profile.poids ? Math.pow(profile.poids, 0.75).toFixed(2) : pm;
        menuGenere = await generateAndSaveMenu(email, profile, saison, updatedPm);
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
    console.error('Erreur PATCH Supabase profil:', res.status, errBody);
  }
}

async function saveChatHistory(email, messages) {
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
      body: JSON.stringify({ chat_history: messages })
    }
  );
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.error('Erreur PATCH chat_history:', res.status, errBody);
  }
}

async function saveObservations(email, newObs) {
  const getRes = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/user?email=eq.${encodeURIComponent(email)}&select=observations`,
    {
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
      }
    }
  );

  let existing = [];
  if (getRes.ok) {
    const data = await getRes.json().catch(() => []);
    if (data && data[0] && Array.isArray(data[0].observations)) {
      existing = data[0].observations;
    }
  }

  const today = new Date().toISOString().split('T')[0];
  const toAdd = newObs
    .filter(o => o && typeof o.texte === 'string' && o.texte.trim())
    .map(o => ({ date: today, texte: o.texte.trim(), source: 'chat' }));

  const merged = [...existing, ...toAdd];
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
      body: JSON.stringify({ observations: merged })
    }
  );
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.error('Erreur PATCH observations:', res.status, errBody);
  } else {
    console.log(`${toAdd.length} observation(s) sauvegardée(s) pour ${email}`);
  }
}

async function generateAndSaveMenu(email, profile, saison, pm) {
  const nom = profile.prenom_chien || profile.prenom || 'ton chien';

  const menuRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 6000,
      system: buildMenuPrompt(profile, saison, pm),
      messages: [{ role: 'user', content: 'Génère le menu de la semaine au format JSON demandé. Réponds uniquement avec le JSON, sans texte avant ni après, sans balises markdown.' }]
    })
  });

  if (!menuRes.ok) {
    const err = await menuRes.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Erreur API Anthropic menu');
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
    console.error('Erreur parsing JSON menu (chat):', parseErr.message);
    throw parseErr;
  }

  // ── 1 SEULE RECETTE sauvegardée ──
  await patchSupabase(email, {
    menu_texte:   menuData.email_html || '',
    recettes:     menuData.recette ? [menuData.recette] : [],
    batch_steps:  menuData.batch_steps || [],
    batch_time:   menuData.batch_time || null,
    batch_special: menuData.batch_special || null,
    courses:      menuData.courses || [],
    cout_semaine: menuData.cout_semaine || null,
    cout_indus:   menuData.cout_indus || null,
    economie:     menuData.economie || null,
    menu_envoye:  true
  });

  await sendEmailMenu(email, nom, menuData.email_html || '');
  console.log(`Menu chat généré et sauvegardé pour ${nom} (${email})`);
  return true;
}

function buildMenuPrompt(profile, saison, pm) {
  const nom = profile.prenom_chien || profile.prenom || 'ton chien';
  const intolerances = Array.isArray(profile.allergies) ? profile.allergies : [];
  const equipement = Array.isArray(profile.equipement) ? profile.equipement : [];

  const interdictionBlock = intolerances.length > 0
    ? `⚠️ INTERDICTION ABSOLUE — LIS CECI EN PREMIER :
Les ingrédients suivants sont STRICTEMENT INTERDITS dans ce menu : ${intolerances.join(', ')}.
NE LES UTILISE JAMAIS, ni dans les recettes, ni dans la liste de courses, ni dans le email_html.

`
    : '';

  return `${interdictionBlock}Tu es Kyno, expert en nutrition canine. Tu génères des menus hebdomadaires pratiques basés sur NRC 2006 et FEDIAF 2023. Tu tutoies le propriétaire. Tu réponds UNIQUEMENT en JSON valide, sans aucun texte avant ou après, sans balises markdown.

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
- Intolérances INTERDITES : ${intolerances.length > 0 ? intolerances.join(', ') : 'aucune'}

## CONCEPT DU MENU
Le propriétaire cuisine UNE SEULE FOIS par semaine — une grande marmite.
- 1 SEULE RECETTE pour toute la semaine, servie matin et soir
- Cuisinée en grande quantité pour 7 jours (×14 repas)
- Conservation : jours 1-2-3 au réfrigérateur, jours 4-5-6-7 au congélateur
- Adapte les légumes et protéines à la saison : ${saison}

## STRUCTURE JSON EXACTE

{
  "recette": {
    "moment": "Menu du jour",
    "color": "#2B3A2E",
    "titre": "nom de la recette, court et appétissant",
    "ration": nombre en grammes par repas (matin = soir = même quantité),
    "ingredients": [
      { "name": "nom de l'ingrédient", "qty": "quantité par repas, ex: 80 g" }
    ],
    "note": "note nutritionnelle courte, 1 phrase, pourquoi cette recette est bonne pour ${nom}"
  },
  "batch_time": "≈ XX min de prépa",
  "batch_steps": [
    { "n": 1, "text": "étape détaillée avec temps de cuisson" },
    { "n": 2, "text": "..." },
    { "n": 3, "text": "..." }
  ],
  "batch_special": "instruction spéciale au moment du repas (huile, CMV, etc.) — à ajouter JAMAIS à la cuisson",
  "courses": [
    { "cat": "Viandes & poissons", "items": [{ "name": "ingrédient", "qty": "quantité totale 7 jours" }] },
    { "cat": "Légumes & féculents", "items": [{ "name": "ingrédient", "qty": "quantité totale 7 jours" }] },
    { "cat": "Compléments", "items": [{ "name": "ingrédient", "qty": "quantité totale 7 jours" }] }
  ],
  "cout_semaine": "XX €",
  "cout_indus": "XX €",
  "economie": "XX €",
  "email_html": "Texte complet du menu en Markdown. Commence par 'Voici le menu de la semaine de ${nom} !'"
}

## RÈGLES
- "ration" dans recette = quantité PAR REPAS (matin et soir identiques)
- "qty" dans ingredients = quantité par repas
- "qty" dans courses = quantité TOTALE pour 7 jours (×14 repas)
- batch_special : toujours mentionner huile + CMV à ajouter au bol au moment du repas
- INTERDICTION ABSOLUE (rappel) : ${intolerances.length > 0 ? intolerances.join(', ') : 'aucune intolérance'}
- JSON strictement valide : pas de virgule finale, toutes les clés entre guillemets doubles`;
}

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
      htmlContent: buildEmailMenuHtml(prenom, htmlMenu)
    })
  });
}

function buildEmailMenuHtml(prenom, htmlContent) {
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
          <p style="margin:0;font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.7);font-weight:600;">Menu mis à jour</p>
          <p style="margin:4px 0 0;font-size:26px;font-weight:700;color:#FBFDF7;">Le nouveau menu de <em style="font-style:normal;color:#FFCE2E;">${prenom}</em></p>
        </td>
      </tr>
      <tr>
        <td style="background:#FBFDF7;padding:40px 48px 0;">
          <p style="margin:0 0 8px;font-size:15px;color:#2B3A2E;">Bonjour !</p>
          <p style="margin:0 0 32px;font-size:14px;color:#7E8C80;line-height:1.8;">Suite à tes échanges avec Kyno, voici le menu adapté aux changements récents de <strong style="color:#2B3A2E;">${prenom}</strong>.</p>
          <div style="height:3px;background:linear-gradient(to right,#2FA35E,#EC6592,#FFCE2E);margin-bottom:32px;border-radius:2px;"></div>
        </td>
      </tr>
      <tr>
        <td style="background:#FBFDF7;padding:0 48px;">
          <div style="background:white;border-radius:12px;padding:36px;border:1px solid #DDE8DA;border-left:4px solid #EC6592;font-size:14px;line-height:1.85;color:#2B3A2E;">
            ${htmlContent}
          </div>
        </td>
      </tr>
      <tr>
        <td style="background:#FBFDF7;padding:32px 48px 40px;">
          <div style="background:#2B3A2E;border-radius:14px;padding:36px;text-align:center;border:3px solid #F2843C;">
            <p style="margin:0 0 16px;font-size:20px;font-weight:700;color:#FBFDF7;line-height:1.3;">Retrouve ce menu dans<br><span style="font-size:14px;font-weight:400;color:rgba(245,240,232,0.5);">ton espace Kyno</span></p>
            <a href="https://project-jlc6z.vercel.app/espace-client.html" style="display:inline-block;background:#2FA35E;color:white;padding:16px 32px;border-radius:4px;text-decoration:none;font-size:13px;font-weight:700;letter-spacing:0.04em;border:2px solid #F2843C;">Accéder à mon espace →</a>
          </div>
        </td>
      </tr>
      <tr>
        <td style="background:#FBFDF7;padding:0 48px 32px;">
          <div style="border-top:1px solid #DDE8DA;padding-top:24px;">
            <p style="margin:0;font-size:11px;color:#7E8C80;line-height:1.7;">⚠ Ce menu est éducatif et ne remplace pas un avis vétérinaire.</p>
          </div>
        </td>
      </tr>
      <tr>
        <td style="background:#233028;border-radius:0 0 16px 16px;padding:28px 48px;border-top:3px solid #EC6592;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td><p style="margin:0;font-size:13px;font-weight:700;color:#FBFDF7;">kyno</p></td>
              <td align="right"><a href="mailto:colinemngl@gmail.com" style="font-size:11px;color:rgba(245,240,232,0.35);text-decoration:none;">colinemngl@gmail.com</a></td>
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

function getSaison() {
  const m = new Date().getMonth() + 1;
  if (m >= 3 && m <= 5) return 'Printemps';
  if (m >= 6 && m <= 8) return 'Été';
  if (m >= 9 && m <= 11) return 'Automne';
  return 'Hiver';
}
