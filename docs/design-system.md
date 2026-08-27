# Système de design, conception

> Statut : les sections **1 à 4 sont implémentées** le 27/08/2026 (surfaces,
> thèmes et accents séparés, sombre adouci, Unicorn caché, paillettes). Restent
> à faire les sections **5 et 6** : dégradés, bento translucides et mode design.
>
> Un écart assumé par rapport à la §3 : le code se tape **n'importe où dans
> l'app**, pas seulement dans la palette, et reste la seule porte d'entrée.
> Unicorn n'apparaît dans les réglages **que tant qu'il est sélectionné** :
> assez pour voir ce qui est actif et pouvoir en sortir, jamais assez pour se
> faire découvrir.
>
> Décisions arrêtées le 26/08/2026.
>
> Maquettes : [mockups/mode-design.html](mockups/mode-design.html) (surfaces,
> dégradés, mode design) et [mockups/themes-accents.html](mockups/themes-accents.html)
> (accents, paillettes). Publiées sur
> https://claude.ai/code/artifact/daf1edce-a999-414c-a450-c5d79b4e7dde et
> https://claude.ai/code/artifact/6f75957f-2b4f-41e5-94ab-d46b9c961f91

## 1. Surfaces : élévations et états

Le défaut actuel : `--surface-hover` sert de fond de zone **statique** à onze
endroits (aperçu, palette, dialogues, transferts, logs, alerte), et
`--surface-active` sert à la sélection. Les noms décrivent des interactions mais
servent d'élévations.

Ce n'est pas qu'un problème de vocabulaire. Le survol étant une **couleur fixe**,
survoler une ligne posée sur une surface déjà surélevée peut la rendre plus
sombre que son support. Invisible en sombre neutre, flagrant dès qu'un accent
teinte les fonds, donc bloquant pour les nouveaux accents.

**Quatre élévations opaques**, qui disent à quelle hauteur on se trouve :

| Variable | Usage |
| --- | --- |
| `--elev-0` | fond de l'application, derrière tout |
| `--elev-1` | panneaux, barres, listes |
| `--elev-2` | zones dans un panneau : en-têtes, champs, cases |
| `--elev-3` | surfaces flottantes : palette, dialogues, menus |

**Trois états en voiles translucides**, valables sur n'importe quelle élévation :

```scss
--state-hover:    rgba(255, 255, 255, .05);   // fonds sombres
--state-active:   rgba(255, 255, 255, .09);
--state-selected: color-mix(in srgb, var(--accent) 18%, transparent);

--state-hover:    rgba(20, 26, 35, .045);     // fonds clairs
--state-active:   rgba(20, 26, 35, .085);
```

Les voiles sont écrits une fois pour les fonds sombres, une fois pour les
clairs, et fonctionnent ensuite avec tous les accents sans retouche. C'est ce
qui rend les accents teintés tenables.

## 2. Thèmes et accents séparés

Le **thème** porte les neutres et les niveaux. L'**accent** porte la rampe de
couleur et une teinte que les élévations absorbent. Aujourd'hui Unicorn est un
thème, donc il duplique vingt variables pour cinq différences utiles.

**Thèmes** : clair, sombre, contraste.

### Le sombre est adouci

Le fond passe de 6 % à 9 % de luminosité : les surfaces se décollent du fond
sans perdre le côté nocturne. `--text-muted` est relevé en conséquence, sinon
les libellés secondaires deviennent trop discrets.

| | Actuel | Adouci (retenu) |
| --- | --- | --- |
| fond | `#0c0e11` | `#101319` |
| surface | `#12151a` | `#171b22` |
| surface-hover | `#181c22` | `#1e232b` |
| surface-active | `#1f242c` | `#252b34` |
| border | `#1e2228` | `#262c35` |
| text-muted | `#8f96a0` | `#98a0aa` |
| text-faint | `#5f6670` | `#626b76` |

Le reste est inchangé (text, accents, danger, ombres, palette de code).
Référence complète avec le SCSS prêt à coller :
https://claude.ai/code/artifact/f68b3492-0fda-47e7-a482-b3c346506740
(copie locale : mockups/theme-adouci.html).

### Quatre accents

| Accent | Solide | Clair (dark) | Note |
| --- | --- | --- | --- |
| Charon | `#5b7fa6` | `#7da3cc` | acier, défaut |
| Unloved | `#d81e4a` | `#ff7f9d` | rouge à pointe rosée |
| Jade | `#2f9e6e` | `#5fc79b` | nom encore ouvert |
| Unicorn | `#e0559f` | `#f480c1` | caché, voir plus bas |

**Le piège d'Unloved.** Un accent rouge saturé entre en collision avec
`--danger` : « Envoyer » et « Supprimer » deviennent la même couleur. La sortie
n'est pas d'affadir l'accent mais de **faire descendre le danger** vers un
bordeaux profond (`#8f2233`) quand Unloved est actif. Le rouge vif devient
l'action normale, le rouge sombre l'action grave.

## 3. Unicorn est caché

Déverrouillage en tapant **`unicorn`** dans la palette de commandes.

**Le point à ne pas rater** : la palette doit alors afficher exactement le même
vide que n'importe quelle recherche infructueuse, avec le message existant
« Aucune commande ne correspond. ». Aucune entrée, aucun indice, aucune
complétion.

Conséquence côté code : le mot ne doit exister **nulle part** dans la liste des
commandes, sinon le moteur de score le ferait remonter. C'est une comparaison à
part, faite sur la saisie avant le filtrage, et le terme reste exclu des
résultats même une fois l'accent déverrouillé. Le déverrouillage est persisté :
l'accent apparaît ensuite dans les réglages, sans jamais réapparaître dans la
palette.

## 4. Les paillettes

Avec l'accent Unicorn **et lui seul**, une traînée de paillettes suit le
curseur **partout dans l'application**, pas seulement pendant un
glisser-déposer. Éclats à quatre branches, palette rose et violet, gravité douce
pour qu'elles retombent.

Trois garde-fous, l'effet étant permanent :

- `prefers-reduced-motion` respecté : l'effet ne se lance pas du tout
- La boucle d'animation **s'éteint** dès que la souris s'arrête et que les
  dernières paillettes ont disparu. Sinon un `requestAnimationFrame` tourne en
  continu et chauffe la machine.
- Le canevas est en `pointer-events: none` par-dessus toute l'application, pour
  ne jamais intercepter un clic, un glisser-déposer ni la saisie du terminal.

Densité volontairement basse : un effet permanent doit être plus discret qu'un
effet ponctuel.

## 5. Dégradés et bento translucides

### Les couleurs sont libres

Le dégradé **ne suit pas l'accent**. Deux couleurs au choix, plus une série de
préréglages pour aller vite. Par défaut il reprend la teinte de l'accent courant
pour que ça fonctionne sans rien régler, et il devient indépendant dès qu'on
touche un sélecteur. Changer d'accent ne réécrit alors plus les couleurs.

Stockage : deux valeurs hexadécimales dans les réglages, plus un drapeau
« suit l'accent ». Les couleurs sont converties en `rgba()` avec une alpha fixe
(0,62 et 0,45), l'intensité restant pilotée séparément par l'opacité du calque.

### Cinq motifs

Le motif dit **comment** les deux couleurs sont posées :

| Motif | Description |
| --- | --- |
| Halo | deux foyers en diagonale, le plus discret |
| Aube | montée de lumière depuis le bas |
| Aurore | écharpe oblique, le plus graphique |
| Maille | quatre foyers en deux teintes, le plus riche |
| Voûte | bords assombris, respiration au centre |

L'intensité (doux, marqué) est un réglage **séparé** du motif : « lequel » et
« combien » ne se mélangent pas.

### Pourquoi les bento sont translucides

Les gouttières du dock font **4 pixels** (`--space-2xs`). Un dégradé posé sur le
fond n'apparaîtrait donc que dans des filets invisibles. Les panneaux passent
donc à **80 % d'opacité** : le plan d'origine et son dégradé se lisent à travers
les bento, et l'effet existe sur toute la surface.

Trois limites à tenir :

- Le contraste du texte baisse : vérifier les libellés secondaires, et **forcer
  l'opacité totale en thème contraste**, où la lisibilité prime.
- Le **terminal reste opaque** quoi qu'il arrive : du texte mono sur un dégradé
  est illisible.
- **Couleurs libres plus bento translucides** est la combinaison la plus
  risquée : deux teintes vives en intensité « marqué » rendent une liste pénible
  à lire. Plafonner l'intensité quand les panneaux sont translucides, plutôt que
  d'interdire des couleurs.

Contrainte technique : le dégradé vit sur un pseudo-élément du conteneur racine,
jamais sur les panneaux. Le dock redimensionne beaucoup, et plusieurs dégradés
repeints à chaque glissement de séparateur coûteraient cher.

## 6. Le mode design

**Design remplace Apparence** et emporte tout : un seul onglet, pas de doublon.

La catégorie ne remplit pas la modale : elle la **referme** et rend
l'application visible, avec un panneau flottant. On règle en voyant le résultat
sur la vraie interface.

Le panneau se **déplace par sa barre de titre** et se **réduit** à cette seule
barre quand il gêne la vue. Il reste contraint dans la fenêtre.

### C'est un brouillon

Tout s'applique immédiatement pour voir, mais **rien n'est enregistré** tant
qu'on n'a pas confirmé. Fermer par la croix ouvre une modale à trois issues :

- **Enregistrer** : le thème devient l'apparence courante
- **Abandonner** : retour à l'état d'avant l'ouverture du mode design
- **Continuer** : on referme la modale et on continue à régler

Fermer sans avoir rien changé ne demande rien. Le pied du panneau indique
« Aucun changement » ou « Non enregistré ».

### Contenu du panneau

Thème, accent, motif de dégradé (en vignettes qui montrent le motif réel),
couleurs du dégradé, intensité, opacité des bento, **rayon des angles** (net,
doux, rond), **taille du texte** (petit, normal, grand) et **filigrane du
logo**.

### Les défauts à l'installation

L'application reste sobre : thème sombre, accent Charon, **aucun dégradé**,
panneaux **opaques**, filigrane **masqué**. Tout le reste se découvre.

## Reste à confirmer

- Le nom **Jade**
- Lesquels des cinq motifs de dégradé on garde vraiment
- **Un thème enregistré, c'est quoi ?** Un seul réglage courant, ou des
  préréglages nommés qu'on rappelle ensuite (« Nuit », « Prod », « Vanina ») ?
- Faut-il adoucir aussi les fonds d'Unicorn et d'Unloved, ou seulement le sombre
  neutre ?
- Un réglage pour couper les paillettes sans changer d'accent, ou elles font
  partie du package Unicorn ?
- La **densité des listes** manque encore : elle touche à l'espacement partout,
  donc c'est un chantier à part.
