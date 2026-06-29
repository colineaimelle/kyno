// api/magic-link.js
// Reçoit l'email depuis acces.html, envoie le lien magique Supabase
// et génère le menu (synchrone — Vercel peut tuer le process avant la fin
// d'un traitement fire-and-forget lancé après la réponse HTTP, donc on attend).

module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email manquant' });

    // ── 1. Envoyer le lien magique via Supabase Auth ──────
    const magicLinkResponse = await fetch(`${process.env.SUPABASE_URL}/auth/v1/otp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
      },
      body: JSON.stringify({
        email: email,
        create_user: true,
        options: {
          email_redirect_to: 'https://project-jlc6z.vercel.app/espace-client.html'
        }
      })
    });

    if (!magicLinkResponse.ok) {
      const err = await magicLinkResponse.json().catch(() => ({}));
      console.error('Erreur envoi magic link:', err);
      return res.status(500).json({ error: 'Impossible d\'envoyer le lien de connexion', detail: err });
    }

    // ── 2. Générer le menu — ON ATTEND LA FIN avant de répondre ──
    try {
      await generateMenuInBackground(email);
    } catch (menuErr) {
      console.error('Erreur génération menu:', menuErr);
    }

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('Erreur magic-link.js:', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Erreur serveur', message: error.message });
    }
  }
};


// ── GÉNÉRATION DU MENU ─────────────────────────────────────
async function generateMenuInBackground(email) {
  const userResponse = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/user?email=eq.${encodeURIComponent(email)}&select=*`,
    {
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
      }
    }
  );
  const users = await userResponse.json();
  if (!users || !users.length) {
    console.error('Profil non trouvé pour génération menu:', email);
    return;
  }
  const profile = users[0];
  const prenomChien = profile.prenom_chien || profile.prenom || 'ton chien';
  const saison = getSaison();
  const pm = profile.poids ? Math.pow(profile.poids, 0.75).toFixed(2) : 'à calculer';

  const menuResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 8000,
      system: buildMenuPrompt(profile, saison, pm),
      messages: [{ role: 'user', content: 'Génère le menu de la semaine au format JSON demandé. Réponds uniquement avec le JSON, sans texte avant ni après, sans balises markdown.' }]
    })
  });

  if (!menuResponse.ok) {
    const err = await menuResponse.json().catch(() => ({}));
    console.error('Erreur génération menu Claude:', err);
    return;
  }

  const menuResult = await menuResponse.json();
  let rawText = menuResult.content[0].text.trim();

  rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');

  const firstBrace = rawText.indexOf('{');
  const lastBrace = rawText.lastIndexOf('}');
  if (firstBrace > 0 || lastBrace < rawText.length - 1) {
    rawText = rawText.slice(firstBrace, lastBrace + 1);
  }

  let menuData;
  try {
    menuData = JSON.parse(rawText);
  } catch (parseErr) {
    console.error('Erreur de parsing JSON du menu:', parseErr.message, '| stop_reason:', menuResult.stop_reason, '| longueur:', rawText.length, '| fin du texte:', rawText.slice(-200));
    return;
  }

  await fetch(`${process.env.SUPABASE_URL}/rest/v1/user?email=eq.${encodeURIComponent(email)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({
      menu_texte:   menuData.email_html || '',
      recettes:     menuData.recette ? [menuData.recette] : [],
      batch_special: menuData.batch_special || null,
      batch_steps:  menuData.batch_steps || [],
      courses:      menuData.courses || [],
      cout_semaine: menuData.cout_semaine || null,
      cout_indus:   menuData.cout_indus || null,
      economie:     menuData.economie || null,
      batch_time:   menuData.batch_time || null,
      menu_envoye:  true
    })
  });

  await sendEmailMenu(email, prenomChien, menuData.email_html || '');

  console.log(`Menu généré et envoyé avec succès pour ${prenomChien} (${email})`);
}

// ── PROMPT MENU ────────────────────────────────────────────
function buildMenuPrompt(profile, saison, pm) {
  const nom = profile.prenom_chien || profile.prenom || 'ton chien';
  const intolerances = Array.isArray(profile.allergies) ? profile.allergies : [];
  const equipement = Array.isArray(profile.equipement) ? profile.equipement : [];

  // FIX : interdiction formulée en premier, en majuscules, avant tout le reste du prompt.
  // Claude peut ignorer une contrainte douce enfouie dans le corps du prompt quand
  // elle entre en conflit avec ses priors nutritionnels (ex: saumon = bon pour les chiens).
  // La placer en ouverture avec un langage catégorique empêche ce comportement.
  const interdictionBlock = intolerances.length > 0
    ? `⚠️ INTERDICTION ABSOLUE — LIS CECI EN PREMIER :
Les ingrédients suivants sont STRICTEMENT INTERDITS dans ce menu : ${intolerances.join(', ')}.
NE LES UTILISE JAMAIS, ni dans les recettes, ni dans la liste de courses, ni dans le email_html.
Peu importe leur valeur nutritionnelle. Une violation de cette règle met la vie du chien en danger.
Si tu n'as aucun autre choix pour une catégorie d'ingrédient, choisis une alternative totalement différente.

`
    : '';

  return `${interdictionBlock}Tu es Kyno, expert en nutrition canine. Tu génères des menus hebdomadaires pratiques et réalistes basés sur NRC 2006 et FEDIAF 2023. Tu tutoies le propriétaire. Tu réponds UNIQUEMENT en JSON valide, sans aucun texte avant ou après, sans balises markdown \`\`\`.

## PROFIL
- Prénom : ${nom}
- Race : ${profile.race || 'non renseigné'}
- Poids : ${profile.poids ? profile.poids + ' kg' : 'non renseigné'} — Poids métabolique : ${pm} kg PM
- Activité : ${profile.activite || 'non renseigné'}
- Saison : ${saison}
- Mode alimentaire : ${profile.modeAlimentaire || 'ration ménagère'}
- Budget : ${profile.budget || 'moyen'}
- Équipement : ${equipement.join(', ') || 'standard'}
- Temps préparation : ${profile.tempsPrep || 'non renseigné'}
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
  "batch_special": "instruction à ajouter UNIQUEMENT au moment du repas, jamais à la cuisson. Ex : Ajouter X ml d'huile de saumon et X g de CMV juste avant de servir. Ne jamais cuire ces compléments.",
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
  "email_html": "Texte complet du menu en Markdown. Utilise \\n pour les retours à la ligne et ** pour le gras. Commence par 'Voici le menu de la semaine de ${nom} !'. Présente la recette unique servie matin et soir, le batch cooking, la liste de courses et le coût."
}

## RÈGLES IMPORTANTES
- "ration" dans recette = quantité PAR REPAS (matin et soir identiques)
- "qty" dans ingredients = quantité par repas
- "qty" dans courses > items = quantité TOTALE pour 7 jours (×14 repas)
- "batch_special" : compléments ajoutés au moment du repas uniquement (huile, CMV, levure, etc.) — jamais cuits
- "cout_indus" est une estimation du prix d'un service de livraison industrielle équivalent (Butternut Box, Pet's Deli) pour comparaison
- "economie" = cout_indus - cout_semaine
- INTERDICTION ABSOLUE (rappel final) : ${intolerances.length > 0 ? `les ingrédients suivants ne doivent apparaître nulle part dans ta réponse : ${intolerances.join(', ')}` : 'aucune intolérance déclarée'}
- Le JSON doit être strictement valide : pas de virgule finale, toutes les clés entre guillemets doubles`;
}

// ── SAISON ────────────────────────────────────────────────
function getSaison() {
  const m = new Date().getMonth() + 1;
  if (m >= 3 && m <= 5) return 'Printemps';
  if (m >= 6 && m <= 8) return 'Été';
  if (m >= 9 && m <= 11) return 'Automne';
  return 'Hiver';
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
      htmlContent: buildEmailMenuHtml(prenom, htmlMenu)
    })
  });
}

// ── TEMPLATE EMAIL MENU ───────────────────────────────────
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
          <p style="margin:0;font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.7);font-weight:600;">Menu personnalisé — semaine 1</p>
          <p style="margin:4px 0 0;font-size:26px;font-weight:700;color:#FBFDF7;">Le menu de la semaine de <em style="font-style:normal;color:#FFCE2E;">${prenom}</em></p>
        </td>
      </tr>

      <tr>
        <td style="background:#FBFDF7;padding:40px 48px 0;">
          <p style="margin:0 0 8px;font-size:15px;color:#2B3A2E;">Bonjour !</p>
          <p style="margin:0 0 32px;font-size:14px;color:#7E8C80;line-height:1.8;">Voici le menu détaillé de la première semaine pour <strong style="color:#2B3A2E;">${prenom}</strong>. Quantités précises, batch cooking et liste de courses inclus. Tu le retrouves aussi dans ton espace Kyno.</p>
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
            <p style="margin:0 0 6px;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:rgba(245,240,232,0.4);">Ton espace Kyno</p>
            <p style="margin:0 0 16px;font-size:20px;font-weight:700;color:#FBFDF7;line-height:1.3;">Retrouve ce menu<br><span style="font-size:14px;font-weight:400;color:rgba(245,240,232,0.5);">et discute des évolutions de ${prenom} avec Kyno</span></p>
            <a href="https://project-jlc6z.vercel.app/espace-client.html" style="display:inline-block;background:#2FA35E;color:white;padding:16px 32px;border-radius:4px;text-decoration:none;font-size:13px;font-weight:700;letter-spacing:0.04em;border:2px solid #F2843C;">Accéder à mon espace →</a>
          </div>
        </td>
      </tr>

      <tr>
        <td style="background:#FBFDF7;padding:0 48px 32px;">
          <div style="border-top:1px solid #DDE8DA;padding-top:24px;">
            <p style="margin:0;font-size:11px;color:#7E8C80;line-height:1.7;">⚠ Ce menu est éducatif et ne remplace pas un avis vétérinaire. En cas de pathologie ou traitement en cours, consulte ton vétérinaire avant tout changement alimentaire.</p>
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
