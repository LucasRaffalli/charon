// Module d'exemple pour Charon — « Compteur de fichiers ».
//
// Il tourne dans un Web Worker sandboxé : pas de DOM, pas de réseau, pas
// d'IPC. Il ne peut agir que via l'objet global `charon` (le SDK injecté),
// et uniquement dans les limites des permissions déclarées au manifeste
// (ici : remote:read, ui:command, events).

// Commande ajoutée à la palette (Cmd+K → « Compter les fichiers du dossier »).
charon.commands.register(
  'compter',
  'Compter les fichiers du dossier',
  async function () {
    try {
      var entries = await charon.fs.remote.currentEntries();
      var files = entries.filter(function (e) { return !e.isDir; }).length;
      var dirs = entries.filter(function (e) { return e.isDir; }).length;
      charon.notify(files + ' fichier(s) et ' + dirs + ' dossier(s) ici.');
    } catch (err) {
      charon.notify('Erreur : ' + err.message, 'error');
    }
  },
  { keywords: 'compter statistiques fichiers dossier' },
);

// Réagit aux événements de l'app (permission « events »).
charon.events.on('path-changed', function () {
  // (démo) — on pourrait rafraîchir un compteur ici.
});

// Appelée par l'hôte à l'activation du module.
self.activate = function (context) {
  charon.notify(
    context.connected
      ? 'Compteur prêt — Cmd+K puis « Compter ».'
      : 'Compteur prêt — connecte-toi, puis Cmd+K → « Compter ».',
  );
};
