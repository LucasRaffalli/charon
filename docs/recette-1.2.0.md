# Recette 1.2.0 « Légion »

Passe de validation avant publication. Rangée par risque : ce qui peut abîmer des
données d'abord, le cosmétique en dernier. Compter 40 minutes.

**Lancer** : `npm run dev` pour tout ce qui suit (rechargement à chaud, console de
debug par clic droit puis Inspecter, à garder ouverte pour voir les erreurs).
Le poids du binaire et le nom « Charon » ne se vérifient qu'après `npm run tauri build`.

**Prérequis** : un serveur distant réel (le VPS, pas localhost : sans latence, le
nouveau téléchargement parallèle ne se distingue pas de l'ancien) et un deuxième
profil pour les tests multi-session.

---

## 0. Préparer le terrain

### Sur le serveur, depuis le terminal intégré

Ça teste le terminal en même temps. Le seuil qui compte est **1 Mio** : en dessous
le téléchargement passe par l'ancienne voie séquentielle, au dessus par la
nouvelle voie parallèle. D'où les deux tailles qui l'encadrent.

```bash
mkdir -p ~/charon-test && cd ~/charon-test
fallocate -l 500K petit-500k.bin      # sous le seuil : voie séquentielle
fallocate -l 2M    moyen-2m.bin       # juste au dessus : voie parallèle
fallocate -l 200M  gros-200m.bin      # mesure du débit
fallocate -l 1G    tres-gros-1g.bin   # coupure réseau et reprise
ls -lh
```

`fallocate` est instantané. S'il manque (BSD, montage exotique), le repli
portable est `head -c 200M /dev/urandom > gros-200m.bin`, plus lent mais avec de
vraies données aléatoires.

Pour éprouver l'affichage d'un dossier chargé (le nouveau rendu à la demande) et
la suppression récursive :

```bash
mkdir -p ~/charon-test/beaucoup && cd ~/charon-test/beaucoup
touch fichier-{1..2000}.txt
mkdir -p ~/charon-test/arbre/{a,b,c}/{1,2,3}
touch ~/charon-test/arbre/{a,b,c}/{1,2,3}/f{1..20}
```

Pour l'aperçu et sa coloration, un fichier qui crève volontairement le plafond
(200 000 caractères) et doit basculer en texte clair sans ralentir la frappe :

```bash
seq 1 200000 | awk '{print "const ligne" $1 " = " $1 ";"}' > ~/charon-test/enorme.ts
seq 1 3000   | awk '{print "const ligne" $1 " = " $1 ";"}' > ~/charon-test/colore.ts
```

### En local (macOS), pour les envois

```bash
mkdir -p ~/Downloads/charon-test && cd ~/Downloads/charon-test
mkfile 200m upload-200m.bin
mkfile 2m   upload-2m.bin
```

`mkfile` est natif macOS. Équivalent portable :
`dd if=/dev/urandom of=upload-200m.bin bs=1m count=200`.

### Nettoyer à la fin

Sur le serveur, `rm -rf ~/charon-test` depuis le terminal, ou mieux : supprimer le
dossier depuis l'explorateur, ce qui refait passer le test de la section 2.
En local, `rm -rf ~/Downloads/charon-test`.

---

## 1. Téléchargements (intégrité des données)

Le seul endroit qui peut corrompre un fichier. Activer d'abord
**Réglages → Fichiers → vérifier l'intégrité des transferts** : chaque transfert
affiche alors un badge sha256, c'est la preuve que les octets sont bons.

- [ ] `gros-200m.bin` depuis le VPS : nettement plus rapide qu'avant, badge vert à l'arrivée
- [ ] `petit-500k.bin` (sous le seuil) : voie séquentielle, se comporte comme avant
- [ ] `moyen-2m.bin` (juste au dessus du seuil) : bascule bien sur la voie parallèle
- [ ] Annulation en plein vol sur `tres-gros-1g.bin` : le `.charonpart` disparaît du dossier local
- [ ] Coupure réseau pendant `tres-gros-1g.bin` (wifi off/on 3 s) : erreur, partiel **conservé**
- [ ] Reprise après cette coupure : le fichier final est complet et **badge vert**
- [ ] Envoi de `upload-200m.bin` depuis le local : inchangé, badge vert
- [ ] Le débit affiché dans le panneau Transferts reste cohérent (il se met à jour ~10 fois par seconde)

> Le test décisif est la reprise après coupure : si le partiel avait des trous, le
> fichier reconstitué serait corrompu sans que rien ne le signale.

## 2. Suppression récursive

- [x] `~/charon-test/beaucoup` (2000 entrées) : quelques secondes au lieu de minutes
- [ ] Dossier sans droits : l'invite sudo native apparaît comme avant, et la suppression aboutit
- [ ] Refuser l'invite sudo : message d'erreur clair, rien n'est supprimé
- [ ] Corbeille (⌘⌫) toujours fonctionnelle, avec le toast **Annuler** qui restaure
- [ ] `~/charon-test/arbre` (arborescence imbriquée) : supprimé entièrement, rien ne reste

Pour fabriquer un dossier que l'utilisateur courant ne peut pas supprimer, et
donc déclencher l'escalade sudo :

```bash
sudo mkdir -p /opt/charon-verrou/sous-dossier
sudo touch /opt/charon-verrou/sous-dossier/f{1..5}
```

Le nettoyer ensuite depuis l'explorateur (c'est le test), ou à la main avec
`sudo rm -rf /opt/charon-verrou`.

## 3. Tour complet de l'interface (passage zoneless)

Le changement le plus transversal : il modifie la façon dont l'affichage se
rafraîchit **partout**. Chercher un endroit qui resterait figé alors qu'il devrait bouger.

- [ ] Connexion, navigation, fil d'Ariane, arborescence
- [ ] Ouvrir `~/charon-test/beaucoup` (2000 entrées) : la liste s'affiche vite et défile sans à-coups
- [ ] Filtre du dossier (entonnoir), compteur « n sur m » qui suit la saisie
- [ ] Sélection multiple : clic, ⇧clic, ⌘clic, ⌘A, flèches, la barre de sélection apparaît et disparaît
- [ ] Renommer (F2), nouveau dossier (⌘⇧N), nouveau fichier
- [ ] Copier / couper / coller (⌘C, ⌘X, ⌘V), les éléments coupés s'affichent estompés
- [ ] Glisser-déposer interne, et ⌥ pendant le dépôt pour copier
- [ ] Barre de progression d'un transfert : elle avance visiblement
- [ ] Terminal : frappe fluide, `cat` d'un gros fichier, redimensionnement, `exit` puis **Relancer**
- [ ] Terminal : le `cd` suit bien le dossier de l'explorateur
- [ ] Dialogues : écrasement (avec diff), permissions, prompt de renommage
- [ ] Toasts : ils apparaissent, la ligne de temps s'écoule, ils partent seuls, le survol suspend
- [ ] Barre d'édition distante : éditer un fichier en externe, elle se masque 10 s après la dernière sauvegarde
- [ ] Palette (⌘K) : la liste se met à jour à chaque frappe, la navigation clavier répond
- [ ] Recherche récursive : les résultats arrivent en flux, la ligne de statut se met à jour
- [ ] Panneau Logs (`tail -F`) : les lignes défilent, l'auto-scroll colle en bas
- [ ] Changement de thème et d'accent : tout se repeint immédiatement

## 4. Premiers chargements (modules devenus paresseux)

Chaque module lourd arrive maintenant à son premier usage. Vérifier qu'aucune
erreur n'apparaît en console à ces moments précis.

- [ ] Première ouverture d'un terminal (xterm)
- [ ] `colore.ts` : la coloration syntaxique apparaît
- [ ] `enorme.ts` (au dessus du plafond) : affiché en clair, la frappe reste fluide
- [ ] Premier fichier `.md` : le rendu s'affiche, la bascule Aperçu/Source marche
- [ ] Enregistrement d'un fichier JS/TS : Prettier le formate (Réglages → Fichiers)
- [ ] Palette avec l'option regex : la bulle d'explication du motif s'affiche
- [ ] Recherche dans le fichier ouvert (⌘F) : le surlignage suit, Entrée enchaîne les occurrences

## 5. Multi-session et vue double

- [ ] ⌘T puis connexion à un deuxième serveur
- [ ] Clic droit sur un onglet → « Côte à côte avec X » : les deux panneaux s'installent
- [ ] Chaque panneau porte bien sa couleur et son nom, les deux terminaux sont séparés
- [ ] Glisser un fichier du serveur A vers le serveur B (le pont), puis avec ⌥ pour copier
- [ ] Couper d'un serveur vers l'autre : le fichier est bien retiré de la source après vérification
- [ ] Journal : les vignettes de couleur distinguent les deux sessions
- [ ] Badge « Transferts · n » : il compte les deux serveurs, même en focalisant l'autre
- [ ] Fermer un onglet : le bilan de session ne raconte QUE ce serveur
- [ ] ⌘R (recharger) : tous les onglets, la vue double et le focus reviennent
- [ ] Défaire le split : l'arborescence se rouvre, Terminal 2 se range

## 6. Deux fenêtres

- [ ] ⌘N ouvre une fenêtre complète
- [ ] Transfert lancé dans la fenêtre 2 : la progression s'affiche **dans celle-là**
- [ ] Terminal dans les deux fenêtres en même temps
- [ ] Copier dans la fenêtre A, coller dans la fenêtre B
- [ ] Glisser un fichier d'une fenêtre à l'autre
- [ ] Changer de thème dans une fenêtre : l'autre suit

## 7. Après `npm run tauri build`

- [ ] Le menu, le Dock et le titre de fenêtre affichent **Charon** (majuscule)
- [ ] Le bundle s'appelle `Charon.app`
- [ ] L'app se lance et se connecte normalement en build release
- [ ] Poids du `.app` : autour de 14 Mo au lieu de 27

---

## Corrections trouvées pendant la recette (à revérifier)

Sorties par la passe du 29/08, toutes corrigées. Les cases cochées sont celles
que tu as déjà validées en direct.

- [x] Terminal : hauteur qui suit le panneau (un `display: block` imposé par
      l'explorateur écrasait le `display: flex` du composant, la grille finissait
      par se mesurer elle-même)
- [ ] Terminal : une ligne de vide en bas, jamais de ligne coupée
- [ ] Terminal : enchaîner plusieurs `exit` puis Relancer sans jamais voir
      « ouverture du canal impossible » (les canaux SSH fuyaient à chaque relance)
- [ ] Aperçu : la notice « fichier volumineux » est lisible en thème sombre
- [ ] Barre de statut : le badge STAGING est lisible dans les trois thèmes
- [ ] Corbeille : elle se met à jour toute seule quand on y jette un fichier
- [ ] Arborescence serveur : elle suit la navigation et les créations sans qu'on
      ait besoin de cliquer dedans
- [ ] Arborescence serveur : au lancement ET après un ⌘R, elle est déjà dépliée
      sur le dossier d'arrivée (plus de « / » vide)
- [ ] Dock : fermer puis rouvrir un panneau du bas le range en onglet avec les
      autres, sans découper la zone
- [ ] Dock : le panneau serveur se ferme et se rouvre, et le dernier panneau
      ouvert refuse de se fermer
- [ ] Terminal : un `mkdir` tapé au clavier apparaît dans le panneau serveur
      après une demi-seconde, et l'arborescence suit
- [ ] Terminal : rien ne se rafraîchit pendant qu'un `vim` ou un `less` est ouvert

## Avant de publier

- [ ] Lancer le **workflow Windows à la main** (déclenchement manuel) : la branche
      Windows du code d'écriture parallèle n'a jamais été compilée ailleurs que
      sur le runner. Le savoir avant que `npm run deploy` attende la CI pour rien.
- [ ] Vérifier que `dist-windows/` ne contient pas d'installeur d'une release précédente
- [ ] `npm run verify` au vert (3370 vérifications)
- [ ] Aucun volume `Charon` ou `charon` monté (sinon le build du DMG échoue)

## Ce qui a cassé

À remplir pendant la passe : l'endroit exact, le geste qui déclenche, et ce qui
apparaît en console.

| Où  | Geste | Symptôme |
| --- | ----- | -------- |
|     |       |          |
