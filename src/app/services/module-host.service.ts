import { Injectable, effect, inject, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import {
  FileEntryDto,
  ModulePanelView,
  ModulePermission,
  ModuleRequest,
  ModuleSummary,
  ModuleView,
} from '@app/interfaces';
import { ActivityLogService } from '@app/services/activity-log.service';
import { PaletteCommand } from '@app/services/command-palette.service';
import { DockService } from '@app/services/dock.service';
import { ModulesService } from '@app/services/modules.service';
import { MODULE_SDK } from '@app/services/module-sdk';
import { SftpService } from '@app/services/sftp.service';
import { TransfersService } from '@app/services/transfers.service';

/** Un module en cours d'exécution dans son Worker. */
interface RunningModule {
  module: ModuleSummary;
  worker: Worker;
  /** Ids de commandes contribuées (pour nettoyage à l'arrêt). */
  commandIds: Set<string>;
}

/** Méthode d'API hôte → permission requise (undefined = toujours permis). */
const METHOD_PERMISSION: Record<string, ModulePermission | undefined> = {
  'commands.register': 'ui:command',
  'events.subscribe': 'events',
  'fs.remote.currentPath': 'remote:read',
  'fs.remote.currentEntries': 'remote:read',
  'fs.remote.list': 'remote:read',
  'fs.remote.mkdir': 'remote:write',
  'fs.remote.createFile': 'remote:write',
  'fs.remote.writeText': 'remote:write',
  'fs.remote.rename': 'remote:write',
  'fs.remote.remove': 'remote:write',
  'fs.local.list': 'local:read',
  'fs.local.readText': 'local:read',
  'sys.stats': 'system:read',
  'sys.diskUsage': 'system:read',
  'storage.get': 'storage',
  'storage.set': 'storage',
  'storage.keys': 'storage',
  'ui.render': 'ui:panel',
  notify: undefined,
};

/** Préfixe des clés de stockage par module (isolées les unes des autres). */
const STORAGE_PREFIX = 'charon:mod:';

/**
 * Hôte d'exécution des modules : chaque module actif tourne dans un **Web
 * Worker** (aucun DOM, aucun réseau, CSP oblige). Le seul canal est postMessage ;
 * chaque appel d'API est vérifié contre les permissions déclarées du module
 * (refus par défaut). Voir docs/modules.md.
 */
@Injectable({ providedIn: 'root' })
export class ModuleHostService {
  private readonly sftp = inject(SftpService);
  private readonly activity = inject(ActivityLogService);
  private readonly modules = inject(ModulesService);
  private readonly dock = inject(DockService);
  private readonly transfers = inject(TransfersService);

  private readonly running = new Map<string, RunningModule>();

  /** Ids de transferts déjà signalés aux modules (évite les doublons). */
  private readonly signaledTransfers = new Set<string>();

  /** Commandes contribuées par les modules (consommées par la palette). */
  private readonly _commands = signal<PaletteCommand[]>([]);
  readonly commands = this._commands.asReadonly();

  /** Vues de panneaux rendues par les modules (consommées par le dock). */
  private readonly _panelViews = signal<ModulePanelView[]>([]);
  readonly panelViews = this._panelViews.asReadonly();

  private prevConnected = false;

  constructor() {
    // Découverte au démarrage puis réconciliation à chaque changement d'état.
    void this.modules.refresh();

    effect(() => {
      const list = this.modules.modules();
      const wanted = new Set(list.filter((m) => m.enabled && !m.error).map((m) => m.slug));
      // Arrêter ce qui n'est plus voulu.
      for (const slug of [...this.running.keys()]) {
        if (!wanted.has(slug)) {
          this.stop(slug);
        }
      }
      // Démarrer les nouveaux.
      for (const m of list) {
        if (m.enabled && !m.error && !this.running.has(m.slug)) {
          void this.start(m);
        }
      }
    });

    // Diffusion d'événements aux modules (permission « events »).
    effect(() => {
      const connected = this.sftp.connected();
      if (connected !== this.prevConnected) {
        this.prevConnected = connected;
        this.broadcast(connected ? 'connected' : 'disconnected', {
          protocol: this.sftp.protocol(),
        });
      }
    });
    effect(() => {
      const path = this.sftp.currentPath();
      this.broadcast('path-changed', { path });
    });

    // Transferts terminés : signalés une seule fois chacun.
    effect(() => {
      for (const t of this.transfers.transfers()) {
        if (t.status === 'done' && !this.signaledTransfers.has(t.id)) {
          this.signaledTransfers.add(t.id);
          this.broadcast('transfer-done', {
            name: t.name,
            direction: t.direction,
            remotePath: t.remotePath,
            localPath: t.localPath,
            size: t.total,
          });
        }
      }
    });
  }

  // ---------- Cycle de vie ----------

  private async start(module: ModuleSummary): Promise<void> {
    let code: string;
    try {
      code = await invoke<string>('module_read_file', { slug: module.slug, file: module.main });
    } catch (error) {
      this.activity.log('error', 'local', module.name, `chargement : ${error}`, false);
      return;
    }

    const source = `${MODULE_SDK}\n/* --- module ${module.slug} --- */\n${code}\n`;
    const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
    let worker: Worker;
    try {
      worker = new Worker(url);
    } catch (error) {
      URL.revokeObjectURL(url);
      this.activity.log('error', 'local', module.name, `worker : ${error}`, false);
      return;
    }
    URL.revokeObjectURL(url);

    const rm: RunningModule = { module, worker, commandIds: new Set() };
    this.running.set(module.slug, rm);

    worker.onmessage = (event: MessageEvent) => void this.onMessage(rm, event.data);
    worker.onerror = (event: ErrorEvent) => {
      this.activity.log('error', 'local', module.name, event.message, false);
    };

    worker.postMessage({
      kind: 'activate',
      granted: module.permissions,
      context: { connected: this.sftp.connected(), protocol: this.sftp.protocol() },
    });
    this.activity.log('module', 'local', module.name, 'activé');
  }

  private stop(slug: string): void {
    const rm = this.running.get(slug);
    if (!rm) {
      return;
    }
    rm.worker.terminate();
    this.running.delete(slug);
    if (rm.commandIds.size > 0) {
      this._commands.update((list) => list.filter((c) => !rm.commandIds.has(c.id)));
    }
    this._panelViews.update((list) => list.filter((v) => v.slug !== slug));
    this.activity.log('module', 'local', rm.module.name, 'désactivé');
  }

  private broadcast(event: string, payload: unknown): void {
    for (const rm of this.running.values()) {
      if (rm.module.permissions.includes('events')) {
        rm.worker.postMessage({ kind: 'invoke', target: `event:${event}`, payload });
      }
    }
  }

  // ---------- Pont : requêtes du module ----------

  private async onMessage(rm: RunningModule, message: ModuleRequest): Promise<void> {
    if (!message || message.kind !== 'request') {
      return;
    }
    try {
      const result = await this.handle(rm, message.method, message.params);
      rm.worker.postMessage({ kind: 'response', id: message.id, result });
    } catch (error) {
      rm.worker.postMessage({ kind: 'response', id: message.id, error: String(error) });
    }
  }

  /** Exécute une méthode d'API après vérification de la permission. */
  private async handle(rm: RunningModule, method: string, params: unknown): Promise<unknown> {
    if (!(method in METHOD_PERMISSION)) {
      throw `Méthode inconnue : ${method}`;
    }
    const required = METHOD_PERMISSION[method];
    if (required && !rm.module.permissions.includes(required)) {
      throw `Permission refusée : ${required}`;
    }
    const p = (params ?? {}) as Record<string, unknown>;

    switch (method) {
      case 'commands.register':
        return this.registerCommand(rm, String(p['id']), String(p['title']), p['keywords'] as string);

      case 'events.subscribe':
        return null; // la permission suffit ; la diffusion est globale

      case 'notify': {
        const level = p['level'] === 'error' ? false : true;
        this.activity.log('module', 'local', rm.module.name, String(p['message']), level);
        return null;
      }

      case 'fs.remote.currentPath':
        return this.sftp.currentPath();

      case 'fs.remote.currentEntries':
        return this.sftp.entries();

      case 'fs.remote.list': {
        const entries = await this.sftp.moduleList(String(p['path'] ?? '/'));
        return entries.map((e) => ({ name: e.name, isDir: e.is_dir, size: e.size }));
      }

      case 'fs.remote.mkdir':
        await this.sftp.moduleMkdir(String(p['path']));
        return null;

      case 'fs.remote.createFile':
        await this.sftp.moduleCreateFile(String(p['path']));
        return null;

      case 'fs.remote.writeText':
        await this.sftp.moduleWriteText(String(p['path']), String(p['content'] ?? ''));
        return null;

      case 'fs.remote.rename':
        await this.sftp.moduleRename(String(p['from']), String(p['to']));
        return null;

      case 'fs.remote.remove':
        await this.sftp.moduleRemove(String(p['path']), Boolean(p['isDir']));
        return null;

      case 'fs.local.list': {
        const entries = await invoke<FileEntryDto[]>('local_list_dir', {
          path: String(p['path']),
        });
        return entries.map((e) => ({ name: e.name, isDir: e.is_dir, size: e.size }));
      }

      case 'fs.local.readText':
        return invoke<string>('local_read_text', {
          path: String(p['path']),
          maxBytes: Number(p['maxBytes'] ?? 262144),
        });

      case 'sys.stats':
        return this.sftp.systemStats();

      case 'sys.diskUsage':
        return this.sftp.diskUsage(String(p['path'] ?? '/'));

      case 'storage.get':
        return this.storageRead(rm.module.slug)[String(p['key'])] ?? null;

      case 'storage.set': {
        const store = this.storageRead(rm.module.slug);
        store[String(p['key'])] = p['value'];
        this.storageWrite(rm.module.slug, store);
        return null;
      }

      case 'storage.keys':
        return Object.keys(this.storageRead(rm.module.slug));

      case 'ui.render':
        return this.renderView(rm, p['view'] as ModuleView, p['title'] as string | undefined);

      default:
        throw `Méthode non gérée : ${method}`;
    }
  }

  // ---------- Panneaux déclaratifs ----------

  /** Enregistre/actualise la vue d'un module et ouvre le panneau Modules. */
  private renderView(rm: RunningModule, view: ModuleView, title?: string): null {
    if (!view || !Array.isArray(view.sections)) {
      throw 'ui.render attend { sections: [...] }.';
    }
    const panelView: ModulePanelView = {
      slug: rm.module.slug,
      moduleName: rm.module.name,
      panelId: `${rm.module.slug}:main`,
      title: title || view.title || rm.module.name,
      view,
    };
    // On n'ouvre le panneau qu'au tout premier rendu (transition vide → vue) :
    // un module qui se rafraîchit souvent ne doit pas le rouvrir de force si
    // l'utilisateur l'a fermé.
    const wasEmpty = this._panelViews().length === 0;
    this._panelViews.update((list) => [
      ...list.filter((v) => v.slug !== rm.module.slug),
      panelView,
    ]);
    if (wasEmpty) {
      this.dock.openPanel('modules');
    }
    return null;
  }

  // ---------- Stockage isolé par module ----------

  private storageKey(slug: string): string {
    return `${STORAGE_PREFIX}${slug}`;
  }

  private storageRead(slug: string): Record<string, unknown> {
    try {
      const raw = localStorage.getItem(this.storageKey(slug));
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private storageWrite(slug: string, data: Record<string, unknown>): void {
    localStorage.setItem(this.storageKey(slug), JSON.stringify(data));
  }

  private registerCommand(
    rm: RunningModule,
    id: string,
    title: string,
    keywords?: string,
  ): null {
    const commandId = `module:${rm.module.slug}:${id}`;
    rm.commandIds.add(commandId);
    const command: PaletteCommand = {
      id: commandId,
      label: title,
      icon: 'layout-grid',
      hint: rm.module.name,
      keywords,
      run: () => rm.worker.postMessage({ kind: 'invoke', target: id }),
    };
    this._commands.update((list) => [...list.filter((c) => c.id !== commandId), command]);
    return null;
  }
}
