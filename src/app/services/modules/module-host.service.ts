import { Injectable, effect, inject, signal } from '@angular/core';
import { windowLabel } from '@app/services/system/window-scope';
import { invoke } from '@tauri-apps/api/core';

import {
  FileEntryDto,
  ModulePanelView,
  ModulePermission,
  ModuleRequest,
  ModuleSummary,
  ModuleView,
} from '@app/interfaces';
import { ActivityLogService } from '@app/services/workspace/activity-log.service';
import { PaletteCommand } from '@app/services/workspace/command-palette.service';
import { DockService } from '@app/services/workspace/dock.service';
import { ModulesService } from '@app/services/modules/modules.service';
import { MODULE_SDK } from '@app/services/modules/module-sdk';
import { SftpService } from '@app/services/connection/sftp.service';
import { SessionRegistry } from '@app/services/connection/session-registry';
import { ToastService } from '@app/services/workspace/toast.service';
import { TransfersService } from '@app/services/files/transfers.service';

/** Un module en cours d'exécution dans son Worker. */
interface RunningModule {
  module: ModuleSummary;
  worker: Worker;
  /** Ids de commandes contribuées (pour nettoyage à l'arrêt). */
  commandIds: Set<string>;
  /** Instant du démarrage : les notifications du réveil ne font pas de toast. */
  startedAt: number;
}

/**
 * Pendant cette fenêtre après le démarrage d'un module, ses `notify` de niveau
 * info vont au journal mais pas en toast : « compteur prêt » à chaque
 * lancement de l'app n'est pas une nouvelle, c'est un module qui se réveille.
 * Une vraie erreur, elle, toaste toujours.
 */
const STARTUP_QUIET_MS = 3000;

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
 * Le panneau Modules a-t-il déjà été ouvert de lui-même une fois ?
 *
 * Il ne fait pas partie de la disposition par défaut, donc la première vue
 * rendue par un module a de bonnes raisons de l'ouvrir. Mais `_panelViews`
 * repart vide à chaque lancement : sans mémoire, cette même première vue
 * rouvrait le panneau à CHAQUE démarrage, y compris après que l'utilisateur
 * l'a fermé. Une fois proposé, il ne s'impose plus jamais.
 */
const PANEL_OFFERED_KEY = 'charon:modules-panel-offered';

/** La disposition du dock (voir DockService) : sa présence date la session. */
const DOCK_STORAGE_KEY = 'charon:dock';

/**
 * Hôte d'exécution des modules : chaque module actif tourne dans un **Web
 * Worker** (aucun DOM, aucun réseau, CSP oblige). Le seul canal est postMessage ;
 * chaque appel d'API est vérifié contre les permissions déclarées du module
 * (refus par défaut). Voir docs/modules.md.
 */
@Injectable({ providedIn: 'root' })
export class ModuleHostService {
  private readonly sessionRegistry = inject(SessionRegistry);

  /** L'API des modules parle à la session focalisée. */
  private get sftp(): SftpService {
    return this.sessionRegistry.focused().sftp;
  }
  private readonly activity = inject(ActivityLogService);
  private readonly toasts = inject(ToastService);
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
  private prevPanelVisible = false;

  constructor() {
    // Les modules ne tournent que dans la fenêtre principale : un Web Worker
    // par module ET par fenêtre ferait N fois le même travail, et un module
    // qui notifie le ferait N fois.
    if (windowLabel() !== 'main') {
      return;
    }

    // Une disposition déjà enregistrée vient d'une session précédente, où le
    // panneau a donc eu l'occasion de s'ouvrir : son absence est un geste, pas
    // un manque. Sans cette reprise, le drapeau ne servirait qu'aux
    // installations neuves et le panneau se rouvrirait une dernière fois chez
    // ceux qui l'avaient justement fermé.
    if (localStorage.getItem(DOCK_STORAGE_KEY)) {
      this.rememberPanelOffered();
    }

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

    // Le panneau des modules est-il sous les yeux de quelqu'un ? Un module qui
    // relève des mesures n'a aucune raison de continuer quand son panneau est
    // fermé ou en second plan derrière un autre onglet : ce serait du travail
    // réseau pour personne, et sur un serveur, du bruit dans les journaux.
    // C'est à l'hôte de le dire, le module ne voyant rien de l'interface.
    effect(() => {
      const visible = this.dock.activePanels().has('modules');
      if (visible !== this.prevPanelVisible) {
        this.prevPanelVisible = visible;
        this.broadcast('panel-visibility', { visible });
      }
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

    const rm: RunningModule = { module, worker, commandIds: new Set(), startedAt: Date.now() };
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
        const ok = p['level'] !== 'error';
        const message = String(p['message']);
        this.activity.log('module', 'local', rm.module.name, message, ok);
        // Un module qui notifie s'adresse à l'utilisateur, pas à un registre :
        // le journal seul enterrait le message dans un onglet souvent fermé.
        // Exception : les infos du réveil (voir STARTUP_QUIET_MS), et une clé
        // par module pour qu'un module bavard remplace son toast au lieu d'en
        // empiler quatre.
        if (ok) {
          if (Date.now() - rm.startedAt >= STARTUP_QUIET_MS) {
            this.toasts.info(message, { detail: rm.module.name, key: `module:${rm.module.slug}` });
          }
        } else {
          this.toasts.error(message, { detail: rm.module.name, key: `module:${rm.module.slug}` });
        }
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
    if (wasEmpty && !this.panelAlreadyOffered()) {
      this.rememberPanelOffered();
      this.dock.openPanel('modules');
    }
    return null;
  }

  private panelAlreadyOffered(): boolean {
    try {
      return localStorage.getItem(PANEL_OFFERED_KEY) === '1';
    } catch {
      // Stockage indisponible : ne pas ouvrir plutôt qu'ouvrir en boucle.
      return true;
    }
  }

  private rememberPanelOffered(): void {
    try {
      localStorage.setItem(PANEL_OFFERED_KEY, '1');
    } catch {
      // sans mémoire du geste, on s'abstiendra la prochaine fois
    }
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
      // Une commande de module reste une commande de l'app.
      category: 'commandes',
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
