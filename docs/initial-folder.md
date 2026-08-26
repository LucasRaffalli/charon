# Dossier initial à la connexion, conception

> Statut : **à implémenter**. Suggestion retenue le 25/08/2026.

Deux chemins facultatifs par profil, un local (« client ») et un distant
(« host »), ouverts automatiquement à la connexion. Vide = comportement actuel.

## Pourquoi

Les deux côtés démarrent aujourd'hui sur une supposition :

- Distant : SFTP tente `/home/<user>` puis retombe sur `/`
  ([sftp.service.ts:187-194](../src/app/services/sftp.service.ts#L187-L194)) ;
  FTP démarre toujours à `/`
- Local : le dossier personnel
  ([local-fs.service.ts:71-83](../src/app/services/local-fs.service.ts#L71-L83))

Or on travaille presque toujours au même endroit pour un serveur donné, donc on
renavigue des deux côtés à chaque connexion. Et la supposition est souvent
fausse : sur un serveur web le compte peut être `www-data` ou n'avoir aucun
dossier personnel, auquel cas on atterrit sur `/`, l'endroit le moins utile.

## Ce qu'il faut faire

1. **`Profile`** (`profiles.rs`) gagne `initial_local_path` et
   `initial_remote_path`, tous deux `Option<String>` avec `#[serde(default)]`
   pour que les profils existants continuent de se charger.
2. **Formulaire de connexion** : deux champs dans les Options avancées, là où vit
   déjà le chemin de clé.
3. **`SftpService.connect`** : utiliser `initial_remote_path` s'il est fourni, à
   la place de la supposition `/home/<user>`.
4. **`LocalFsService.init`** : utiliser `initial_local_path`. C'est le seul point
   qui demande du câblage, `init()` ne connaissant pas le profil aujourd'hui.

## Deux détails qui font la différence

- **Bouton « utiliser le dossier courant »** dans l'édition du profil, pour
  capturer l'endroit où l'on se trouve plutôt que de taper le chemin.
- **Repli silencieux** : si le dossier a disparu depuis, retomber sur le
  comportement actuel avec un message, jamais sur une erreur de connexion.
