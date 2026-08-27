/**
 * SDK injecté dans le Web Worker d'un module, AVANT son code.
 * Il expose `charon.*` (promesses au-dessus de postMessage) et route les
 * messages de l'hôte. Le module ne peut RIEN faire d'autre que d'appeler ce
 * SDK : pas de DOM (contexte Worker), pas de réseau (CSP), pas d'IPC.
 *
 * Chaîne brute (exécutée dans le worker). Ne pas importer de dépendances ici.
 */
export const MODULE_SDK = String.raw`
(function () {
  var _seq = 0;
  var _pending = new Map();
  var _commands = new Map();   // id -> handler
  var _events = new Map();     // event -> Set<cb>

  function _request(method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++_seq;
      _pending.set(id, { resolve: resolve, reject: reject });
      self.postMessage({ kind: 'request', id: id, method: method, params: params });
    });
  }

  self.onmessage = function (e) {
    var msg = e.data || {};
    if (msg.kind === 'response') {
      var p = _pending.get(msg.id);
      if (!p) return;
      _pending.delete(msg.id);
      if (msg.error != null) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    } else if (msg.kind === 'invoke') {
      var target = msg.target || '';
      if (target.indexOf('event:') === 0) {
        var ev = target.slice(6);
        var set = _events.get(ev);
        if (set) set.forEach(function (cb) { try { cb(msg.payload); } catch (_) {} });
      } else {
        var handler = _commands.get(target);
        if (handler) { try { handler(msg.payload); } catch (_) {} }
      }
    } else if (msg.kind === 'activate') {
      self.charon._granted = msg.granted || [];
      self.charon._context = msg.context || {};
      if (typeof self.activate === 'function') {
        try { self.activate(self.charon._context); } catch (err) {
          self.charon.notify('Erreur d\'activation : ' + err.message, 'error');
        }
      }
    }
  };

  self.charon = {
    _granted: [],
    _context: {},

    commands: {
      register: function (id, title, handler, opts) {
        _commands.set(id, handler);
        return _request('commands.register', {
          id: id, title: title, keywords: (opts && opts.keywords) || undefined,
        });
      },
    },

    events: {
      on: function (event, cb) {
        if (!_events.has(event)) _events.set(event, new Set());
        _events.get(event).add(cb);
        return _request('events.subscribe', { event: event });
      },
    },

    fs: {
      remote: {
        currentPath: function () { return _request('fs.remote.currentPath'); },
        currentEntries: function () { return _request('fs.remote.currentEntries'); },
        list: function (path) { return _request('fs.remote.list', { path: path }); },
        mkdir: function (path) { return _request('fs.remote.mkdir', { path: path }); },
        createFile: function (path) { return _request('fs.remote.createFile', { path: path }); },
        writeText: function (path, content) {
          return _request('fs.remote.writeText', { path: path, content: content });
        },
        rename: function (from, to) { return _request('fs.remote.rename', { from: from, to: to }); },
        remove: function (path, isDir) {
          return _request('fs.remote.remove', { path: path, isDir: !!isDir });
        },
      },
      local: {
        list: function (path) { return _request('fs.local.list', { path: path }); },
        readText: function (path, maxBytes) {
          return _request('fs.local.readText', { path: path, maxBytes: maxBytes });
        },
      },
    },

    // Instantané système du serveur (permission system:read, SFTP uniquement).
    sys: {
      stats: function () { return _request('sys.stats'); },
      diskUsage: function (path) { return _request('sys.diskUsage', { path: path }); },
    },

    // Stockage persistant isolé par module (permission storage).
    storage: {
      get: function (key) { return _request('storage.get', { key: key }); },
      set: function (key, value) { return _request('storage.set', { key: key, value: value }); },
      keys: function () { return _request('storage.keys'); },
    },

    // Panneau déclaratif : le module émet une structure, l'hôte la rend
    // nativement (aucun HTML/JS injecté). Permission ui:panel.
    ui: {
      render: function (view, title) {
        return _request('ui.render', { view: view, title: title });
      },
    },

    notify: function (message, level) {
      return _request('notify', { message: String(message), level: level || 'info' });
    },
  };
})();
`;
