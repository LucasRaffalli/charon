/**
 * Lire une image choisie par l'utilisateur pour en faire un filigrane.
 *
 * Deux contraintes commandent tout : la CSP n'autorise que `'self'` et
 * `data:` pour les images (donc pas de chemin de fichier, qui cesserait de
 * marcher au premier déplacement du fichier), et le stockage local se compte
 * en méga-octets. Une photo d'appareil fait plusieurs mégas en data-URI et
 * remplirait le quota à elle seule.
 *
 * L'image est donc redessinée dans un canevas à une taille de filigrane
 * raisonnable, puis encodée en WebP. Un filigrane s'affiche à 460 px au plus,
 * et sous une opacité de quelques pour cent : le détail au-delà ne se voit
 * pas, et il coûte cher.
 */

/** Côté maximal de l'image conservée, en pixels. Le double de la taille
 *  d'affichage, pour les écrans à haute densité. */
const MAX_SIDE = 920;

/** Au-delà, on refuse plutôt que de faire ramer le navigateur à l'ouverture. */
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

export interface WatermarkRead {
  dataUrl: string;
  /** Taille du data-URI en octets, pour l'annoncer si elle surprend. */
  bytes: number;
}

/**
 * Rend le data-URI redimensionné, ou `null` si le fichier n'est pas une
 * image lisible. Les erreurs ne sont pas des exceptions : choisir un mauvais
 * fichier est un geste banal, pas une panne.
 */
export async function readWatermark(file: File): Promise<WatermarkRead | null> {
  if (!file.type.startsWith('image/') || file.size > MAX_SOURCE_BYTES) {
    return null;
  }
  const source = URL.createObjectURL(file);
  try {
    const image = await load(source);
    const scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
      return null;
    }
    context.drawImage(image, 0, 0, width, height);
    // WebP avec transparence : un logo découpé garde son fond transparent,
    // ce qui compte pour un filigrane. Qualité basse assumée, l'image est
    // affichée à quelques pour cent d'opacité.
    const dataUrl = canvas.toDataURL('image/webp', 0.8);
    return { dataUrl, bytes: dataUrl.length };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(source);
  }
}

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('image illisible'));
    image.src = src;
  });
}
