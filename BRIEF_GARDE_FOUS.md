# Brief pour Claude Code : garde-fous nutritionnels des menus

Contexte : un menu généré pour Tetu (chihuahua, 2 kg, senior) affichait environ 75 kcal pour une cible d'environ 170 kcal, sans huile ni CMV, avec un batch cooking qui ne correspondait pas aux recettes. Aucun client n'a reçu ce menu, mais Coline veut qu'un menu faux ne puisse jamais être affiché ni envoyé.

Principe : chaque menu passe par une seule et même fonction de vérification avant d'être enregistré, affiché ou envoyé par email. Si une vérification échoue, le menu n'est pas publié.

Règles toujours valables : branche `charte-kyno`, ne touche pas à `main`, sans capture d'écran ni navigateur, commit après chaque étape, aucune migration exécutée par toi (montre le SQL à Coline).

## 0. Avant de coder

Réponds d'abord aux 3 questions du message précédent sur Tetu (cible kcal, huile et CMV, batch cooking). Puis liste à Coline tous les endroits où un menu est généré ou régénéré : `api/generate.js`, `api/magic-link.js`, `api/cron-menu.js`, `api/generate-menu-chien.js`, `api/chat.js` s'il en régénère, et tout autre fichier.

## 1. Un seul pipeline de génération

Crée dans `api/lib/` une fonction unique, par exemple `genererMenuChien(chien, foyer)`, qui fait toujours les mêmes étapes, dans cet ordre :
1. calcul de la cible (besoinKcalJour, règle senior, poids de forme s'il existe) ;
2. génération de la recette par Claude ;
3. ajusterRations() ;
4. vérification (§2) ;
5. enregistrement dans `chien` seulement si la vérification réussit.

Tous les fichiers listés au §0 appellent cette fonction. Plus aucun chemin de génération ne la contourne.

## 2. Vérifications obligatoires (`api/lib/verifierMenu.js`)

La fonction renvoie `{ ok: true }` ou `{ ok: false, raisons: [...] }`. Elle vérifie :

1. **Calories** : kcal réels de la recette entre 90 % et 110 % de la cible du chien. Si ce n'est pas le cas après ajusterRations(), un seul nouvel ajustement est tenté, puis échec.
2. **CMV** : un complément minéral et vitaminé est présent, avec une quantité supérieure à 0.
3. **Huile** : au moins une huile est présente, avec une quantité supérieure à 0.
4. **Ration par kilo** : grammes par jour divisés par le poids du chien, entre `RATION_G_PAR_KG_MIN` et `RATION_G_PAR_KG_MAX`. Mets ces deux valeurs dans un fichier de constantes, avec les valeurs proposées 15 et 120, et un commentaire « à valider par Coline ».
5. **Densité** : kcal par gramme de la ration entre 0,7 et 2,5. Mêmes constantes, à valider par Coline.
6. **Apports** : protéines, calcium et oméga-3 à au moins 80 % de leur cible (le même seuil que le trait affiché dans l'espace client).
7. **Allergies et intolérances** : aucun ingrédient interdit ni dérivé, avec la règle existante de Kyno (aliment déclaré et tous ses dérivés). Pour le poisson : aucune huile de poisson, de saumon ni farine de poisson.
8. **Prénom et chien** : la recette est bien rattachée à ce chien (id).

## 3. En cas d'échec

1. La nouvelle recette n'est pas enregistrée.
2. Si le chien avait déjà une recette valide, elle reste affichée. Sinon, l'espace client affiche : « Le menu de [Prénom] est en cours de vérification. Il arrive très vite. »
3. Aucun email de menu n'est envoyé pour ce chien.
4. Email d'alerte à `ALERT_EMAIL` : objet « Menu bloqué : [Prénom] », avec l'id du chien, la cible kcal, les kcal obtenus et la liste des raisons.
5. Log serveur sans email client ni données de santé en clair.

## 4. Batch cooking et liste de courses

Le batch cooking commun et la liste de courses sont reconstruits à chaque génération, y compris celle d'un seul chien, uniquement à partir des recettes validées et actuelles de chaque chien actif (`chien.recette`). Ils ne mentionnent aucun ingrédient absent de ces recettes. Prénoms avec majuscule.

## 5. Affichage de la portion

La portion du jour affiche tous les ingrédients de la recette, y compris l'huile et le CMV, avec leurs quantités.

## 6. Copie à Coline pendant la bêta

Si la variable d'environnement `COPIE_MENUS_COLINE` vaut `oui`, chaque premier menu d'un nouveau chien est aussi envoyé à `ALERT_EMAIL`, avec le profil du chien (race, poids, âge, objectif, allergies), la cible kcal et la recette complète. Ça n'empêche pas l'envoi au client.

## 7. Chiens de test

Crée `tests/verifier-menu.test.js`, lancé avec `node tests/verifier-menu.test.js`, sans appel à l'IA. Il vérifie `verifierMenu` sur des recettes d'exemple :
- chihuahua senior de 2 kg : recette correcte (acceptée), recette à 75 kcal (refusée), recette sans CMV (refusée) ;
- braque de 13 kg en sous-poids avec poids de forme de 25 kg : cible calculée sur le premier palier de reprise, recette correcte acceptée ;
- chien de 21 kg allergique au poisson : recette avec huile de saumon (refusée), avec colza et lin (acceptée) ;
- épagneul de 13 kg actif : recette correcte acceptée, recette à 130 % de la cible refusée.

Le test affiche OK ou ÉCHEC pour chaque cas. Il doit passer avant chaque push qui touche à la génération des menus.

## 8. Contrôles avant de rendre la main

1. Dis à Coline les valeurs à valider (§2.4 et §2.5) et d'ajouter `COPIE_MENUS_COLINE=oui` dans Vercel (Production et Preview) si elle le souhaite.
2. Résultat du test du §7.
3. Régénère le menu de Tetu (une fois, via le bouton) et donne à Coline sa cible kcal, ses kcal réels et sa recette complète.
4. Push sur `charte-kyno`.
5. Vérifier que toutes les migrations du dossier `migrations/` ont été exécutées dans Supabase (SQL Editor), en particulier `add_colonnes_chien_manquantes.sql`. Un PATCH qui échoue avec PGRST204 indique une colonne manquante — corriger avant la fusion dans `main`.
6. Lancer `scripts/reverifier-recettes.js` sur tous les chiens actifs et valider que les recettes existantes passent ; backfiller `recette_verifiee = true` pour celles qui passent avant de fusionner.
