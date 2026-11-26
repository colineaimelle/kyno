// api/lib/verifierMenu.js
// Vérification nutritionnelle d'un menu généré.
// Renvoie { ok: true } ou { ok: false, raisons: string[] }.

const { kcalTotale } = require('./calories');
const { getTermesExclus, detecterTermeInterdit } = require('./allergenes');
const {
  TOLERANCE_KCAL_PCT,
  RATION_G_PAR_KG_MIN,
  RATION_G_PAR_KG_MAX,
  DENSITE_KCAL_G_MIN,
  DENSITE_KCAL_G_MAX,
  SEUIL_APPORTS_MIN_PCT,
} = require('./constantes');

// mc         : entrée "chiens[i]" du JSON Claude (après ajusterRations)
// chien      : ligne Supabase du chien
// ciblesKcal : { [chien_id]: number }
function verifierMenu(mc, chien, ciblesKcal) {
  const raisons = [];
  const poids   = parseFloat(chien.poids) || 0;
  const cible   = ciblesKcal[chien.id] || ciblesKcal[String(chien.id)];
  const ingsCrus = Array.isArray(mc.ingredients_grammes_crus) ? mc.ingredients_grammes_crus : [];

  // ── 1. ingredients_grammes_crus obligatoires ───────────────────────────────
  if (ingsCrus.length === 0) {
    raisons.push('ingredients_grammes_crus absent ou vide — rations non vérifiables');
  }

  // ── 2. Calories ────────────────────────────────────────────────────────────
  if (ingsCrus.length > 0 && cible) {
    const { kcal, inconnus } = kcalTotale(ingsCrus);
    if (kcal > 0) {
      const ecart = Math.abs(kcal - cible) / cible;
      if (ecart > TOLERANCE_KCAL_PCT) {
        raisons.push(
          `Calories : ${Math.round(kcal)} kcal/jour vs cible ${cible} kcal (écart ${Math.round(ecart * 100)} %)`
        );
      }
    } else {
      raisons.push(`Calories : kcal calculables nulles (ingrédients inconnus : ${inconnus.join(', ')})`);
    }
  }

  // ── 3. CMV ─────────────────────────────────────────────────────────────────
  // Doit figurer dans ingredients_grammes_crus avec une quantité > 0 — batch_special ne suffit pas.
  const hasCMV = ingsCrus.some(
    i => /cmv|compl[eé]ment\s*min[eé]r/i.test(i.name) && (i.qty_g_jour || 0) > 0
  );
  if (!hasCMV) raisons.push('CMV absent de ingredients_grammes_crus');

  // ── 4. Huile ───────────────────────────────────────────────────────────────
  // Idem : doit figurer dans ingredients_grammes_crus avec une quantité > 0.
  const hasHuile = ingsCrus.some(
    i => /huile/i.test(i.name) && (i.qty_g_jour || 0) > 0
  );
  if (!hasHuile) raisons.push('Huile absente de ingredients_grammes_crus');

  // ── 5. Ration par kilo ─────────────────────────────────────────────────────
  if (poids > 0 && ingsCrus.length > 0) {
    const totalGJour = ingsCrus.reduce((s, i) => s + (parseFloat(i.qty_g_jour) || 0), 0);
    if (totalGJour > 0) {
      const ratioGKg = totalGJour / poids;
      if (ratioGKg < RATION_G_PAR_KG_MIN) {
        raisons.push(`Ration trop faible : ${ratioGKg.toFixed(1)} g/kg (min ${RATION_G_PAR_KG_MIN})`);
      }
      if (ratioGKg > RATION_G_PAR_KG_MAX) {
        raisons.push(`Ration trop élevée : ${ratioGKg.toFixed(1)} g/kg (max ${RATION_G_PAR_KG_MAX})`);
      }
    }
  }

  // ── 6. Densité énergétique ─────────────────────────────────────────────────
  if (ingsCrus.length > 0) {
    const { kcal } = kcalTotale(ingsCrus);
    const totalGJour = ingsCrus.reduce((s, i) => s + (parseFloat(i.qty_g_jour) || 0), 0);
    if (totalGJour > 0 && kcal > 0) {
      const densite = kcal / totalGJour;
      if (densite < DENSITE_KCAL_G_MIN) {
        raisons.push(`Densité trop faible : ${densite.toFixed(2)} kcal/g (min ${DENSITE_KCAL_G_MIN})`);
      }
      if (densite > DENSITE_KCAL_G_MAX) {
        raisons.push(`Densité trop élevée : ${densite.toFixed(2)} kcal/g (max ${DENSITE_KCAL_G_MAX})`);
      }
    }
  }

  // ── 7. Apports (protéines, calcium, oméga-3) ──────────────────────────────
  if (Array.isArray(mc.apports) && mc.apports.length > 0) {
    const surveilles = ['Protéines', 'Calcium', 'Oméga-3'];
    for (const nom of surveilles) {
      const apport = mc.apports.find(a => a.nom === nom);
      if (apport && apport.cible > 0) {
        const pct = apport.pct != null
          ? apport.pct
          : Math.round((apport.valeur / apport.cible) * 100);
        if (pct < SEUIL_APPORTS_MIN_PCT) {
          raisons.push(`${nom} : ${pct} % de la cible (min ${SEUIL_APPORTS_MIN_PCT} %)`);
        }
      }
    }
  }

  // ── 8. Allergies & intolérances ────────────────────────────────────────────
  const termesExclus = getTermesExclus(Array.isArray(chien.allergies) ? chien.allergies : []);
  if (termesExclus.length > 0) {
    const textes = [
      ...(mc.recette?.ingredients || []).map(i => i.name || ''),
      mc.batch_special || '',
    ];
    for (const texte of textes) {
      const found = detecterTermeInterdit(texte, termesExclus);
      if (found) {
        raisons.push(`Allergie : "${found}" interdit (trouvé dans "${texte.slice(0, 60)}")`);
      }
    }
  }

  // ── 9. chien_id cohérent ───────────────────────────────────────────────────
  if (mc.chien_id !== chien.id && mc.chien_id !== String(chien.id)) {
    raisons.push(`chien_id mismatch : attendu ${chien.id}, reçu ${mc.chien_id}`);
  }

  return { ok: raisons.length === 0, raisons };
}

module.exports = { verifierMenu };
