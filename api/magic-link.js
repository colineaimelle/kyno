// api/magic-link.js
// Reçoit l'email depuis acces.html, envoie le lien magique Supabase
// et déclenche la génération du menu en arrière-plan (fire-and-forget).

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
    // On utilise la SERVICE_KEY (clé secrète serveur) plutôt que l'ANON_KEY :
    // c'est un appel serveur-à-serveur avec create_user:true, qui nécessite
    // des privilèges admin avec le nouveau système de clés Supabase (sb_secret_...).
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

    // ── 2. Répondre immédiatement au client ────────────────
    res.status(200).json({ success: true });

    // ── 3. Lancer la génération du menu en arrière-plan ────
    // (fire-and-forget — ne bloque pas la réponse HTTP ci-dessus)
    generateMenuInBackground(email).catch(err => {
      console.error('Erreur génération menu en arrière-plan:', err);
    });

  } catch (error) {
    console.error('Erreur magic-link.js:', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Erreur serveur', message: error.message });
    }
  }
};

// ── GÉNÉRATION DU MENU EN ARRIÈRE-PLAN ─────────────────────
async function generateMenuInBackground(email) {
  // 1. Récupérer le profil complet du chien depuis Supabase
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

  // 2. Générer le menu via Claude — UNE SEULE RÉPONSE EN JSON STRUCTURÉ
  // Le JSON contient à la fois le texte lisible pour l'email ET les données
  // structurées pour l'espace client (recettes, courses, batch cooking, coût).
  // Avantage : un seul appel, jamais de désynchronisation entre les deux formats,
  // pas de parsing fragile de texte libre.
  const menuResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 4500,
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

  // Sécurité : enlever d'éventuelles balises ```json si le modèle les ajoute
  rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');

  let menuData;
  try {
    menuData = JSON.parse(rawText);
  } catch (parseErr) {
    console.error('Erreur de parsing JSON du menu:', parseErr, rawText);
    return;
  }

  // 3. Sauvegarder les données structurées dans Supabase (pour l'espace client)
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/user?email=eq.${encodeURIComponent(email)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({
      menu_texte: menuData.email_html || '',
      recettes: [menuData.recette_matin, menuData.recette_soir].filter(Boolean),
      batch_steps: menuData.batch_steps || [],
      courses: menuData.courses || [],
      cout_semaine: menuData.cout_semaine || null,
      cout_indus: menuData.cout_indus || null,
      economie: menuData.economie || null,
      batch_time: menuData.batch_time || null,
      menu_envoye: true
    })
  });

  // 4. Envoyer le menu par email (texte lisible, même niveau de détail qu'avant)
  await sendEmailMenu(email, prenomChien, menuData.email_html || '');

  console.log(`Menu généré et envoyé avec succès pour ${prenomChien} (${email})`);
}

// ── PROMPT MENU (riche : quantités, batch cooking, courses, coût) ──
function mergeAutre(arr, autre, excludeVals = []) {
  const base = Array.isArray(arr) ? arr.filter(v => !excludeVals.includes(v) && v !== 'autre' && v !== 'autres') : [];
  if (autre && autre.trim()) base.push(autre.trim());
  return base;
}

function buildMenuPrompt(profile, saison, pm) {
  const nom = profile.prenom_chien || profile.prenom || 'ton chien';
  const intolerances = mergeAutre(profile.intolerances, profile.intolerancesAutre, ['aucune']);
  const equipement = Array.isArray(profile.equipement) ? profile.equipement : [];

  return `Tu es Kyno, expert en nutrition canine. Tu génères des menus hebdomadaires pratiques et réalistes basés sur NRC 2006 et FEDIAF 2023. Tu tutoies le propriétaire. Tu réponds UNIQUEMENT en JSON valide, sans aucun texte avant ou après, sans balises markdown \`\`\`.

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
- Intolérances à exclure absolument : ${intolerances.length > 0 ? intolerances.join(', ') : 'aucune'}

## CONCEPT DU MENU
Le propriétaire cuisine UNE SEULE FOIS par semaine — une grande marmite.
- 2 recettes uniquement : une pour le repas du MATIN, une pour le repas du SOIR
- Les recettes sont cuisinées en grande quantité pour toute la semaine (×7 jours)
- Conservation : jours 1-2-3 au réfrigérateur, jours 4-5-6-7 au congélateur en portions
- Les portions sont décongelées la veille au frigo
- Adapte les légumes et protéines à la saison : ${saison}

## STRUCTURE JSON EXACTE À RESPECTER

{
  "recette_matin": {
    "moment": "Le matin",
    "color": "#FFCE2E",
    "titre": "nom de la recette, court et appétissant",
    "ration": nombre en grammes (ration par repas, pas le total semaine),
    "ingredients": [
      { "name": "nom de l'ingrédient", "qty": "quantité par repas, ex: 80 g" }
    ],
    "note": "note nutritionnelle courte, 1 phrase, pourquoi cette recette est bonne pour ${nom}"
  },
  "recette_soir": {
    "moment": "Le soir",
    "color": "#2FA35E",
    "titre": "nom de la recette, court et appétissant",
    "ration": nombre en grammes (ration par repas, pas le total semaine),
    "ingredients": [
      { "name": "nom de l'ingrédient", "qty": "quantité par repas, ex: 105 g" }
    ],
    "note": "note nutritionnelle courte, 1 phrase"
  },
  "batch_time": "≈ XX min de prépa",
  "batch_steps": [
    { "n": 1, "text": "étape détaillée et concrète, avec temps de cuisson si pertinent" },
    { "n": 2, "text": "..." },
    { "n": 3, "text": "..." },
    { "n": 4, "text": "..." }
  ],
  "courses": [
    { "name": "ingrédient", "qty": "quantité totale pour 7 jours, ex: 560 g" }
  ],
  "cout_semaine": "XX,XX €",
  "cout_indus": "XX €",
  "economie": "XX,XX €",
  "email_html": "Texte complet du menu en Markdown, formaté EXACTEMENT comme l'exemple ci-dessous, avec quantités pour 7 jours dans les recettes, préparation, batch cooking, conditionnement, liste de courses, coût. Utilise \\n pour les retours à la ligne et ** pour le gras. Commence par 'Voici le menu de la semaine de ${nom} !'"
}

## EXEMPLE DE STRUCTURE POUR email_html (respecte ce niveau de détail)
"# Voici le menu de la semaine de ${nom} !\\n\\n## 1. QUANTITÉ JOURNALIÈRE\\nTotal journalier : Xg par jour - Repas du matin (40%) : Xg - Repas du soir (60%) : Xg\\n\\n## 2. RECETTE MATIN — [titre]\\n### Ingrédients pour 7 jours (X total) :\\n- ...\\n### Préparation :\\n1. ...\\n\\n## 3. RECETTE SOIR — [titre]\\n[même format]\\n\\n## 4. SESSION BATCH COOKING\\nJour recommandé : ... Durée totale : ...\\n### Déroulé optimisé :\\n...\\n\\n## 5. CONDITIONNEMENT\\n### Stockage :\\n...\\n### Conseils :\\n...\\n\\n## 6. LISTE DE COURSES\\n### 🥩 Viandes & Poissons\\n...\\n### 🥕 Légumes & Féculents\\n...\\n### 🧴 Compléments & Huiles\\n...\\n\\n## 7. COÛT ESTIMÉ\\n...\\n💰 Total semaine : environ X€\\n\\n## 🎯 POINTS CLÉS POUR ${nom}\\n✅ ...\\n\\nBon appétit à ${nom} ! 🐾"

Règles importantes :
- Les valeurs "ration" et "qty" dans recette_matin/recette_soir sont les quantités PAR REPAS (pas le total semaine)
- Les valeurs "qty" dans "courses" sont les quantités TOTALES pour 7 jours
- "color" reste fixe : "#FFCE2E" pour le matin, "#2FA35E" pour le soir
- "cout_indus" est une estimation du prix d'un service de livraison industrielle équivalent (Butternut Box, Pet's Deli) pour comparaison
- "economie" = cout_indus - cout_semaine
- Respecte les intolérances : ${intolerances.length > 0 ? intolerances.join(', ') : 'aucune'}
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
