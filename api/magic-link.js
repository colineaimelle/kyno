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
  // 1. Récupérer le profil du chien depuis Supabase
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

  // 2. Générer le menu via Claude
  const menuResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 3000,
      system: buildMenuPrompt(profile),
      messages: [{ role: 'user', content: 'Génère le menu de la semaine.' }]
    })
  });

  if (!menuResponse.ok) {
    const err = await menuResponse.json().catch(() => ({}));
    console.error('Erreur génération menu Claude:', err);
    return;
  }

  const menuResult = await menuResponse.json();
  const menu = menuResult.content[0].text;

  // 3. Sauvegarder le menu dans Supabase
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/user?email=eq.${encodeURIComponent(email)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({
      menu_texte: menu,
      menu_envoye: true
    })
  });

  console.log(`Menu généré avec succès pour ${prenomChien} (${email})`);
}

// ── PROMPT MENU ─────────────────────────────────────────────
function buildMenuPrompt(profile) {
  const nom = profile.prenom_chien || profile.prenom || 'le chien';
  return `Tu es Kyno, expert en nutrition canine. Génère un menu de la semaine pour ${nom}, basé sur son profil :

- Race : ${profile.race || 'non renseigné'}
- Poids : ${profile.poids ? profile.poids + ' kg' : 'non renseigné'}
- Plan : ${profile.plan || 'beta'}

Génère :
1. Une recette du matin avec ingrédients et quantités en grammes
2. Une recette du soir avec ingrédients et quantités en grammes
3. Une note nutritionnelle courte pour chaque recette
4. La liste de courses complète pour la semaine (ingrédients additionnés × 7 jours)

Format clair, tutoiement, ton chaleureux et expert. Reste concret et actionnable.`;
}
