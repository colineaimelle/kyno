# TODO — Chantiers en attente

## quiz-complet.html — Question jour d'envoi

Lors de l'intégration du nouveau quiz 35 questions (`quiz-complet.html`),
ajouter la question suivante **entre Q34 (attentes libres) et Q35 (email + offre)**.

### Libellé et structure (reproduire le style Cormorant/DM Sans existant)

```html
<!-- Q35 — JOUR D'ENVOI (insérer avant le step email/offre) -->
<div class="q-card" data-step="35">
  <div class="q-eyebrow">Préférences</div>
  <h2 class="q-title">Quel jour veux-tu<br><em>recevoir ton menu ?</em></h2>
  <p class="q-sub">Tu pourras le modifier à tout moment depuis ton espace Kyno.</p>
  <div class="opts grid2" id="jourEnvoiOpts">
    <button class="opt selected" onclick="pickJour(this,1)"><span class="opt-check"></span>Lundi</button>
    <button class="opt" onclick="pickJour(this,2)"><span class="opt-check"></span>Mardi</button>
    <button class="opt" onclick="pickJour(this,3)"><span class="opt-check"></span>Mercredi</button>
    <button class="opt" onclick="pickJour(this,4)"><span class="opt-check"></span>Jeudi</button>
    <button class="opt" onclick="pickJour(this,5)"><span class="opt-check"></span>Vendredi</button>
    <button class="opt" onclick="pickJour(this,6)"><span class="opt-check"></span>Samedi</button>
    <button class="opt" onclick="pickJour(this,7)"><span class="opt-check"></span>Dimanche</button>
  </div>
</div>
```

### JS à ajouter dans le bloc `<script>`

```js
// Initialiser la valeur par défaut
A['jourEnvoi'] = 1;

function pickJour(btn, val) {
  document.querySelectorAll('#jourEnvoiOpts .opt').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  A['jourEnvoi'] = val;
}
```

### Dans la soumission finale, ajouter au body envoyé à `/api/generate`

```js
jourEnvoi: A['jourEnvoi'] || 1,
```

### Notes
- Décaler l'ancien step 35 (email + offre) en step 36, et mettre TOTAL = 36.
- La valeur `jourEnvoi` est déjà traitée côté serveur dans `api/generate.js` (validation 1-7).

---

## Sécurité — Ticket séparé (ne pas corriger ici)

Voir rapport RLS dans le commit du chantier jour_envoi.
