# Recherche, conception

> Statut : **à implémenter**. Décisions arrêtées le 25/08/2026.
>
> Maquette des états de la palette : [mockups/palette-recherche.html](mockups/palette-recherche.html)
> (ouvrir dans un navigateur), publiée sur
> https://claude.ai/code/artifact/50680da0-644f-430b-a1aa-b8311f6a9af7

## Périmètre

Trois portées distinctes, souvent confondues sous le mot « recherche ». Les
trois sont dans le périmètre, mais elles n'ont ni le même coût ni la même
architecture.

| Portée | Où | Backend |
| --- | --- | --- |
| A. Filtre du listing | dossier affiché | non, front seul |
| B. Recherche dans le fichier | aperçu ouvert | non, front seul |
| C. Recherche récursive | toute l'arborescence serveur | oui |

Règle commune : **le texte brut est le mode par défaut**, la regex est un filtre
qu'on active. Une recherche courante ne doit pas obliger à échapper un point ou
une parenthèse, et un motif tapé au hasard ne doit jamais devenir une regex
coûteuse par accident. En mode texte, la saisie est échappée avant d'être
compilée ou envoyée. En mode regex, un motif invalide est signalé et n'est
jamais transmis.

## A. Filtre du listing

Filtre le dossier **déjà chargé**, sans aucun appel réseau.

- Champ de filtre au-dessus de la liste, dans `FilePane`
- Signal `filter` porté par `FileBrowserState`, donc gratuit pour le panneau
  local **et** le panneau serveur qui en héritent tous les deux
- `entries` devient un computed filtré ; le tri dossiers d'abord est conservé
- Filtre par type en complément : tout / dossiers / fichiers / extension
- Le filtre se vide au changement de dossier

## B. Recherche dans le fichier ouvert

Cherche dans le contenu **déjà en mémoire** de `PreviewService`, donc sans
relire le fichier.

- Barre de recherche dans l'en-tête de l'aperçu, ouverte par **Cmd+F sur macOS
  et Ctrl+F sur Windows**. Comme la palette, les deux liaisons sont déclarées
  côte à côte (`keydown.meta.f` et `keydown.control.f`), il n'y a pas de
  détection de plateforme.
- Compteur « n sur m », navigation précédent/suivant, Entrée pour enchaîner,
  Échap pour fermer
- Chaque occurrence est surlignée, l'occurrence courante différemment

### Comment surligner sans casser la coloration

L'éditeur superpose déjà deux couches alignées au pixel par le mixin SCSS
`editor-metrics` : le `<pre>` colorisé par Prism, et le textarea au texte
transparent. Injecter des `<mark>` dans le HTML de Prism casserait ses spans de
tokens.

Décision : **une troisième couche, tout en dessous**, qui rend le même texte
avec le même mixin, en texte transparent, et dont seuls les fonds d'occurrence
sont visibles. L'empilement devient, de bas en haut : occurrences, coloration,
textarea. Le défilement des trois est déjà synchronisé par `syncScroll`.

## C. Recherche récursive sur le serveur

La grosse pièce. Deux besoins à ne pas confondre : chercher par **nom de
fichier**, et chercher dans le **contenu**.

### Stratégie : exec d'abord, walk en repli

**Voie 1, canal exec (SFTP).** `find` pour les noms, `grep -rE` pour le
contenu. Le travail se fait sur le serveur, donc c'est le seul moyen viable sur
une grosse arborescence : pas d'aller-retour réseau par fichier. C'est déjà le
mécanisme du suivi de logs, qui exécute `tail -F` sur un canal exec.

**Voie 2, walk SFTP.** Parcours récursif depuis Rust. Plus lent (un aller-retour
par dossier) et incapable de chercher dans le contenu sans télécharger, mais il
ne dépend d'aucun binaire distant et **fonctionne en FTP**.

Décision : exec par défaut en SFTP, repli automatique sur le walk si la commande
est absente ou refusée. En FTP, seul le walk existe, donc **recherche par nom
uniquement**, ce que l'interface doit annoncer clairement.

### Commandes et flux

Le résultat doit s'afficher au fil de l'eau, pas en un bloc à la fin. On reprend
exactement le modèle de `tail_open` :

- `search_start(connection_id, root, query, options) -> search_id`
- Événements `search:hit` (résultats par lots), `search:done` (avec le compte et
  la raison d'arrêt), `search:error`
- `search_stop(search_id)` pour annuler
- Registre `SearchRegistry` calqué sur `TailRegistry`
- `ConnectionHold` pris pendant toute la recherche, sinon la fermeture pour
  inactivité peut couper une recherche longue

### Sécurité

Le point critique : la requête de l'utilisateur devient un argument de commande
distante.

- Chemin **et** motif passés par `shell_quote` (quotes simples POSIX, déjà
  utilisé pour `tail`). Rien ne peut s'échapper de la chaîne.
- `--` avant les chemins, pour qu'un nom commençant par `-` ne soit pas lu comme
  une option
- Les commandes sont **construites par Charon**, jamais fournies par
  l'utilisateur. Aucune saisie ne devient un nom de binaire ou une option.
- `grep -E` (POSIX étendu) et non `-P` : PCRE n'est pas présent partout, et sa
  surface est nettement plus large
- `grep -I` pour ignorer les binaires
- Les résultats sont filtrés par `is_safe_entry_name`, comme les listings

### Garde-fous

- Plafond de résultats (1000 par défaut), arrêt annoncé plutôt que troncature
  silencieuse
- Délai maximal (60 s par défaut), profondeur maximale
- Exclusions par défaut : `.git`, `node_modules`, `vendor`, modifiables
- `nice` sur la commande distante pour ne pas peser sur un serveur de production
- **Sur un profil `prod`, une recherche de contenu depuis la racine exige
  toujours une confirmation**, en retapant le nom d'hôte comme ailleurs dans
  l'app. La recherche par nom n'est pas concernée.

## La palette est le point d'entrée

La palette de commandes est **un outil de raccourci** : elle donne tout,
directement. Elle s'ouvre déjà par **Cmd+K sur macOS et Ctrl+K sur Windows**,
les deux liaisons étant déjà déclarées côte à côte dans `CommandPalette`, donc
rien à adapter par plateforme.

**Pas de préfixe obligatoire.** On tape, tout est cherché d'un coup. Les
préfixes restent des accélérateurs pour qui les connaît, et le `/` des chemins
continue de fonctionner comme aujourd'hui.

### Groupement par catégorie

Pour ne pas noyer la palette, les résultats sont **groupés par catégorie**,
chaque groupe plafonné à deux ou trois lignes, avec le compte réel rappelé à
côté du titre. Catégories : Profils, Commandes, Chemins, Fichiers, Contenu,
Filtres.

### La catégorie devient un filtre

C'est le mécanisme central. Choisir une catégorie la fait **descendre dans le
champ comme premier filtre**. Dès lors, **tout se cherche dedans et rien en
dehors** : les groupes disparaissent, la liste ne montre plus que cette
catégorie, et il y a la place d'afficher davantage de résultats.

La catégorie **Filtres** expose les options à qui ne connaît pas les préfixes,
au même titre que les autres catégories.

### La rangée de saisie

Elle se lit **loupe, filtres, motif**, en zones séparées par des filets :

```
┌──────┬──────────┬───────┬────────────────────────────────┐
│  🔍  │ fichiers │ regex │ ^charon-(access|error)\.log$   │
└──────┴──────────┴───────┴────────────────────────────────┘
```

- La loupe occupe une **case carrée**, aussi large que la rangée est haute (une
  variable `--row-h` sert aux deux, pour qu'elles ne se désynchronisent pas)
- **Chaque filtre a sa propre case**, fond `--surface-hover` légèrement décalé,
  filet entre chacune. Ce sont des zones du champ, pas des pastilles posées
  dessus.
- Le filtre de **catégorie** est le premier et se distingue par un texte plein
  (`--text`), les options restant en `--text-muted` : c'est lui qui décide où on
  cherche, les autres ne font qu'affiner
- **Aucun accent** sur les filtres. L'accent reste réservé au surlignage des
  occurrences dans les résultats, seul endroit où il porte une information.
- Le survol éclaircit la case et révèle sa croix ; retour arrière sur une saisie
  vide retire la dernière
- **Six cases au maximum.** Le septième filtre est **refusé**, avec une bulle qui
  l'explique. Rien n'est retiré automatiquement.

### La bulle d'explication

En mode regex, une bulle au-dessus du champ **traduit le motif en français** et
rappelle les symboles utilisés, pour savoir ce qu'on cherche avant de lancer.
Sur un motif invalide, elle dit où ça coince en pointant le caractère fautif.

La traduction ne pourra pas couvrir toutes les regex : gérer les cas courants
(ancres, classes, quantificateurs, alternatives) et retomber sur le seul rappel
des symboles quand le motif est trop tordu, plutôt que de sortir une phrase
fausse.

## Couleurs de statut à ajouter aux thèmes

Quatre variables par thème, chacune avec son fond tramé, sur le modèle du
`--danger` / `--danger-bg` déjà en place. Désaturées à la même intensité que
l'accent acier : lisibles comme un signal, jamais fluo.

| Variable | Clair | Sombre | Usage |
| --- | --- | --- | --- |
| `--success` | `#2e7d52` | `#74c496` | recherche terminée, motif valide |
| `--warning` | `#8a5a00` | `#d9a441` | plafond atteint, action coûteuse |
| `--error` | `#b3362c` | `#e5726a` | motif invalide, erreur serveur |
| `--pending` | `#5d55a6` | `#9a8fd8` | recherche en cours, transfert actif |

`--error` reprend exactement le `--danger` existant, pour ne pas avoir deux
rouges qui cohabitent. Le violet de `--pending` a été choisi distinct des trois
autres **et** du bleu de l'accent, sinon un transfert en cours se confondrait
avec un élément sélectionné.

La couleur reste au minimum dans l'interface de recherche : ligne de statut en
bas, et filet gauche de la bulle. Le champ et les résultats restent neutres.

## Le panneau Recherche

Un **nouveau panneau dockable** `search`, donc une entrée dans `DockPanelId`,
`PANEL_META` et `REOPEN_ZONES`. Il prend le relais de la palette pour la liste
complète : résultats groupés par fichier avec la ligne et son numéro, options en
clair, indicateur d'activité et bouton d'arrêt.

Un clic sur un résultat ouvre le fichier dans l'aperçu et saute à la ligne, en
réutilisant le surlignage de la portée B.

Autre point d'entrée : le clic droit sur un dossier serveur, pour chercher à
partir de là.

## Hors périmètre

- Remplacer dans les résultats (search and replace)
- Recherche dans l'arborescence **locale** (le filtre de la portée A suffit)
- Index persistant entre deux sessions
- Recherche de contenu en FTP, impossible sans canal exec

## Ordre d'implémentation

A, puis B, puis C. Les deux premières sont front seul et livrables
indépendamment ; la portée C réutilise le surlignage de B pour l'ouverture d'un
résultat.

## Reste à confirmer

- La liste des catégories (Profils, Commandes, Chemins, Fichiers, Contenu,
  Filtres) est-elle complète ?
- Le filtre de catégorie doit-il vraiment se distinguer visuellement des filtres
  d'option, ou tous identiques ?
- Avec six filtres et un motif long, la saisie devient étroite. Les cases
  passent à la ligne, ou on abaisse le plafond ?
