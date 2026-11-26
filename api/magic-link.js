// api/magic-link.js

// Reçoit l'email depuis acces.html, envoie le lien magique Supabase
// et génère le menu (synchrone — Vercel peut tuer le process avant la fin
// d'un traitement fire-and-forget lancé après la réponse HTTP, donc on attend).

const SITE_URL = process.env.SITE_URL || (process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'https://kyno.fr');
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || 'colinemngl@gmail.com';
const ALERT_EMAIL   = process.env.ALERT_EMAIL   || CONTACT_EMAIL;
const { genererMenuFoyer } = require('./_lib/genererMenuChien');

module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const { action, email, redirectTo } = req.body || {};

    // ── Enregistrement du consentement commande (§3) ─────────────────────────
    if (action === 'consent') {
      const { cgv_version, case_cgv, case_retractation, case_newsletter, page } = req.body;
      if (!cgv_version) return res.status(400).json({ error: 'Données manquantes' });
      let insertOk = false;
      try {
        const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/consent_logs`, {
          method: 'POST',
          headers: {
            'apikey': process.env.SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
          },
          body: JSON.stringify({
            email:             email || null,
            cgv_version,
            case_cgv:          !!case_cgv,
            case_retractation: !!case_retractation,
            case_newsletter:   !!case_newsletter,
            page:              page || null,
          }),
        });
        if (r.ok) insertOk = true;
      } catch (e) {}
      if (!insertOk) {
        await sendBrevoEmail(ALERT_EMAIL, 'Kyno Admin',
          'ALERTE — Échec enregistrement consentement',
          `<p><strong>L&#x2019;enregistrement dans consent_logs a échoué.</strong></p>
           <p>Email : ${email || 'inconnu'}</p>
           <p>Page : ${page || '?'}</p>
           <p>CGV version : ${cgv_version || '?'}</p>
           <p>Heure : ${new Date().toISOString()}</p>`
        ).catch(() => {});
        return res.status(500).json({ error: 'Échec de l\'enregistrement du consentement' });
      }
      return res.status(200).json({ success: true });
    }

    // ── Rétractation (§4.1) ────────────────────────────────────────────────────
    if (action === 'retractation') {
      const { subscription_date } = req.body;
      if (!email) return res.status(400).json({ error: 'Email manquant' });
      const dateStr = new Date().toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Europe/Paris' });
      await Promise.all([
        sendBrevoEmail(CONTACT_EMAIL, 'Kyno Admin',
          `Demande de rétractation – ${email}`,
          `<p>Rétractation reçue le <strong>${dateStr}</strong>.</p>
           <p>Client : <strong>${email}</strong></p>
           <p>Date d’abonnement : ${subscription_date || 'non renseignée'}</p>`),
        sendBrevoEmail(email, email,
          'Kyno – Confirmation de rétractation',
          `<p>Nous avons bien reçu ta rétractation du <strong>${dateStr}</strong>. Tu seras remboursé du montant restant sous 14 jours au plus tard, par le même moyen de paiement.</p>
           <p>Une question ? Écris-nous à <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>`),
      ]);
      return res.status(200).json({ success: true });
    }

    // ── Résiliation (§4.2) ─────────────────────────────────────────────────────
    if (action === 'resiliation') {
      if (!email) return res.status(400).json({ error: 'Email manquant' });
      const dateStr = new Date().toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Europe/Paris' });
      await Promise.all([
        sendBrevoEmail(CONTACT_EMAIL, 'Kyno Admin',
          `Demande de résiliation – ${email}`,
          `<p>Résiliation demandée le <strong>${dateStr}</strong>.</p>
           <p>Client : <strong>${email}</strong></p>
           <p>Action : arrêter l’abonnement dans Stripe à la fin de la période en cours.</p>`),
        sendBrevoEmail(email, email,
          'Kyno – Confirmation de résiliation',
          `<p>Nous avons bien reçu ta demande de résiliation du <strong>${dateStr}</strong>. Ton abonnement sera arrêté à la fin de ta période en cours. Tu recevras une confirmation dès que la résiliation est effective.</p>
           <p>Une question ? Écris-nous à <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>`),
      ]);
      return res.status(200).json({ success: true });
    }

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
          email_redirect_to: redirectTo || 'https://project-jlc6z.vercel.app/espace-client.html'
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
  const sbHeaders = {
    'apikey': process.env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
  };

  // Charger le foyer et tous les chiens actifs
  const [usersRes, chiensRes] = await Promise.all([
    fetch(`${process.env.SUPABASE_URL}/rest/v1/user?email=eq.${encodeURIComponent(email)}&select=*`, { headers: sbHeaders }),
    fetch(`${process.env.SUPABASE_URL}/rest/v1/chien?user_email=eq.${encodeURIComponent(email)}&actif=eq.true&order=ordre.asc&select=*`, { headers: sbHeaders }),
  ]);

  const users  = usersRes.ok  ? await usersRes.json().catch(() => [])  : [];
  const chiens = chiensRes.ok ? await chiensRes.json().catch(() => []) : [];

  if (!users.length) {
    console.error('[magic-link] Profil non trouvé pour génération menu:', email);
    return;
  }
  const foyer = users[0];

  if (!chiens.length) {
    console.log('[magic-link] Aucun chien actif — génération ignorée pour:', email);
    return;
  }

  const chiensToProcess = chiens.slice(0, 4);
  const prenomChien = chiensToProcess.map(c => c.prenom_chien || 'Chien').join(' & ');

  // Pipeline unifié
  const { menuData, ciblesKcal, echecs, stats } = await genererMenuFoyer(chiensToProcess, foyer);

  console.log(`[magic-link] Menu ${stats.resultat} — ${stats.nbOk}/${stats.nbTotal} chiens, ${stats.tentatives} essai(s)`);

  if (!menuData.chiens || !menuData.chiens.length) {
    console.error('[magic-link] Aucun menu valide généré pour:', email);
    return;
  }

  // Sauvegarder par chien
  await Promise.all(menuData.chiens.map(async mc => {
    const chienPatch = {};
    if (mc.recette)                                                        chienPatch.recette             = mc.recette;
    if (mc.recette)                                                        chienPatch.recette_verifiee    = true;
    if (mc.score_sante != null)                                            chienPatch.score_sante         = mc.score_sante;
    if (Array.isArray(mc.score_bullets) && mc.score_bullets.length)       chienPatch.score_bullets       = mc.score_bullets.slice(0, 3);
    if (mc.proteine_principale)                                            chienPatch.proteine_principale = mc.proteine_principale;
    if (Array.isArray(mc.apports) && mc.apports.length)                   chienPatch.apports             = mc.apports;
    if (mc.batch_special)                                                  chienPatch.batch_special       = mc.batch_special;
    if (Array.isArray(mc.ingredients_grammes_crus) && mc.ingredients_grammes_crus.length)
                                                                           chienPatch.ingredients_grammes_crus = mc.ingredients_grammes_crus;
    if (!Object.keys(chienPatch).length) return;
    await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/chien?id=eq.${encodeURIComponent(mc.chien_id)}`,
      { method: 'PATCH', headers: { ...sbHeaders, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }, body: JSON.stringify(chienPatch) }
    ).then(r => { if (!r.ok) r.text().then(t => console.error(`[magic-link] PATCH chien ${mc.chien_id}:`, t)); });
  }));

  // Sauvegarder au niveau foyer
  const foyerPatch = {
    menu_texte:   '',
    recettes:     menuData.chiens.map(mc => mc.recette).filter(Boolean),
    batch_steps:  menuData.batch_cooking_commun || [],
    courses:      menuData.courses_commune || [],
    cout_semaine: menuData.cout_semaine || null,
    cout_indus:   menuData.cout_indus || null,
    economie:     menuData.economie || null,
    batch_time:   menuData.batch_time || null,
    menu_envoye:  true,
  };
  const patchRes = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/user?email=eq.${encodeURIComponent(email)}`,
    { method: 'PATCH', headers: { ...sbHeaders, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }, body: JSON.stringify(foyerPatch) }
  );
  if (!patchRes.ok) console.error('[magic-link] PATCH foyer:', await patchRes.text().catch(() => ''));

  // Email de notification avec données du premier chien
  const premierMc = menuData.chiens[0];
  const emailData = {
    recette:      premierMc.recette,
    batch_time:   menuData.batch_time,
    cout_semaine: menuData.cout_semaine,
  };
  await sendEmailMenu(email, prenomChien, emailData);

  console.log(`[magic-link] Menu généré et envoyé pour ${prenomChien} (${email})`);
}

// ── EMAIL GÉNÉRIQUE (rétractation, résiliation, consentement) ────────────────
async function sendBrevoEmail(toEmail, toName, subject, bodyHtml) {
  const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:32px 16px;background:#FFF4E0;font-family:Arial,Helvetica,sans-serif;color:#451A36;font-size:16px;line-height:1.6;">
${bodyHtml}
<p style="margin-top:24px;font-size:13px;color:#6E4A63;">Kyno &middot; &eacute;dit&eacute; par Elycoop, coop&eacute;rative d&apos;activit&eacute; et d&apos;emploi</p>
</body></html>`;
  return fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
    body: JSON.stringify({ sender: { name: 'Kyno', email: CONTACT_EMAIL }, to: [{ email: toEmail, name: toName }], subject, htmlContent: html }),
  });
}

// ── EMAIL MENU ────────────────────────────────────────────
async function sendEmailMenu(email, prenom, menuData) {
  await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': process.env.BREVO_API_KEY
    },
    body: JSON.stringify({
      sender: { name: 'Kyno', email: 'colinemngl@gmail.com' },
      to: [{ email, name: prenom }],
      subject: `Le menu de la semaine de ${prenom}`,
      htmlContent: buildEmailMenuHtml(prenom, menuData)
    })
  });
}

// ── TEMPLATE EMAIL MENU ───────────────────────────────────
function buildEmailMenuHtml(prenom, data = {}) {
  const titre = data.recette && data.recette.titre ? data.recette.titre : null;
  const ration = data.recette && data.recette.ration ? data.recette.ration + ' g' : null;
  const batchTime = data.batch_time || null;
  const cout = data.cout_semaine || null;
  const accessUrl = `${SITE_URL}/espace-client.html`;

  const recapRows = [
    titre ? `<tr><td style="padding:11px 16px;background:#DDF3F1;font-weight:700;font-size:15px;color:#451A36;font-family:Arial,Helvetica,sans-serif;">${titre}</td></tr>` : '',
    ration ? `<tr><td style="padding:11px 16px;${titre ? 'border-top:2px solid #E8DCC6;' : 'background:#DDF3F1;font-weight:700;'}font-size:15px;color:#451A36;font-family:Arial,Helvetica,sans-serif;">Sa portion du jour&nbsp;&nbsp;&nbsp;<b>${ration}</b></td></tr>` : '',
    batchTime ? `<tr><td style="padding:11px 16px;border-top:2px solid #E8DCC6;font-size:15px;color:#451A36;font-family:Arial,Helvetica,sans-serif;">Temps de pr&eacute;pa&nbsp;&nbsp;&nbsp;<b>${batchTime}</b></td></tr>` : '',
    cout ? `<tr><td style="padding:11px 16px;border-top:2px solid #E8DCC6;font-size:15px;color:#451A36;font-family:Arial,Helvetica,sans-serif;">Co&ucirc;t de la semaine&nbsp;&nbsp;&nbsp;<b>${cout}</b></td></tr>` : '',
  ].filter(Boolean).join('');

  const recapTable = recapRows
    ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:3px solid #451A36;border-radius:16px;overflow:hidden;margin:0 0 20px;">${recapRows}</table>`
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
        <img src="${SITE_URL}/email-entete-menu.png" width="600" height="150" alt="Kyno" style="display:block;width:100%;max-width:600px;">
      </td>
    </tr>

    <tr>
      <td style="padding:30px 32px 26px;">
        <h1 style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:28px;line-height:1.25;font-weight:700;color:#451A36;">
          Le menu de la semaine de <span style="display:inline-block;background:#F27A9B;border:3px solid #451A36;border-radius:10px;padding:0 8px 2px;">${prenom}</span>
        </h1>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#451A36;font-family:Arial,Helvetica,sans-serif;">
          Son menu de la semaine est pr&ecirc;t.
        </p>
        ${recapTable}
        <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#451A36;font-family:Arial,Helvetica,sans-serif;">
          Ta liste de courses et ton batch cooking t&apos;attendent dans ton espace Kyno.
        </p>
        <table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
          <tr>
            <td bgcolor="#E5432F" style="border-radius:999px;border:3px solid #451A36;">
              <a href="${accessUrl}" style="display:inline-block;padding:14px 26px;color:#FFF4E0;font-family:Arial,Helvetica,sans-serif;font-size:17px;font-weight:700;text-decoration:none;white-space:nowrap;">Ouvrir son menu</a>
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
