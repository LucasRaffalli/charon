/**
 * Le contrat de types de l'application, rangé par domaine et réexporté à plat :
 * les consommateurs importent depuis `@app/interfaces` sans avoir à savoir où
 * chaque type habite.
 */

export * from './connection/connection';
export * from './connection/profile';
export * from './files/file-entry';
export * from './files/path-segment';
export * from './files/stat';
export * from './files/transfer';
export * from './files/tree-node';
export * from './workspace/activity';
export * from './workspace/dock';
export * from './workspace/toast';
export * from './appearance/accent';
export * from './appearance/appearance';
export * from './appearance/theme';
export * from './system/changelog';
export * from './system/module';
export * from './system/settings';
