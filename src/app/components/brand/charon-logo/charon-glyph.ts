import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Glyphe Charon (154×154) inliné, même dessin que src/assets/charon-logo.svg
 * mais inséré dans le DOM pour que l'inner-shadow (filtre SVG) soit rendu à la
 * résolution de l'écran (net sur retina, contrairement à un <img> qui rasterise
 * le filtre à la taille CSS puis l'agrandit).
 *
 * Dimensionné par le parent (le SVG remplit 100 % de l'hôte).
 * L'identifiant de filtre est global : une seule instance par écran.
 */
@Component({
  selector: 'app-charon-glyph',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: block;
      line-height: 0;
      /* La teinte suit le thème : clair sur fond sombre, encre sur fond
         clair. Les valeurs d'origine étaient figées (#E5EDF5 + liseré blanc),
         invisibles en thème clair. */
      color: var(--text, #e5edf5);
    }
    svg {
      display: block;
      width: 100%;
      height: 100%;
    }
  `,
  template: `
    <svg viewBox="0 0 154 154" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g filter="url(#filter0_i_2030_452)">
        <path
          d="M0 150.391C0 152.384 1.61597 154 3.60938 154H150.391C152.384 154 154 152.384 154 150.391V114.207C154 111.535 151.202 109.797 148.847 111.058C131.409 120.398 115.858 132.801 102.914 147.548C101.452 149.213 98.8528 149.247 97.3482 147.621C85.7932 135.132 72.3173 124.445 57.3898 116.031C55.8837 115.183 55.1605 113.403 55.6468 111.744C64.9152 80.1252 64.361 45.8956 54.1745 14.5996C53.0553 11.1614 57.204 7.84425 60.3117 9.69265C87.4329 25.824 119.022 33.8462 150.602 32.6413C152.511 32.5684 154 30.9844 154 29.0738V3.60938C154 1.61597 152.384 0 150.391 0H3.60938C1.61597 0 0 1.61597 0 3.60938V150.391Z"
          fill="currentColor"
        />
      </g>
      <path
        d="M3.60938 0.0498047H150.391C152.356 0.0498047 153.95 1.64359 153.95 3.60938V29.0742C153.95 30.9584 152.481 32.519 150.6 32.5908C119.029 33.7954 87.4497 25.7757 60.3369 9.64941C58.7613 8.71248 56.9249 9.08723 55.627 10.125C54.329 11.1629 53.5595 12.8719 54.127 14.6152C64.3104 45.9016 64.8642 80.1208 55.5986 111.729C55.1058 113.411 55.8389 115.215 57.3652 116.075C72.2881 124.486 85.7601 135.17 97.3115 147.655C98.8364 149.303 101.47 149.268 102.951 147.581C115.892 132.838 131.438 120.439 148.87 111.103C151.19 109.86 153.95 111.572 153.95 114.207V150.391C153.95 152.356 152.356 153.95 150.391 153.95H3.60938C1.64359 153.95 0.0498047 152.356 0.0498047 150.391V3.60938C0.049805 1.64359 1.64359 0.0498049 3.60938 0.0498047Z"
        stroke="currentColor"
        stroke-opacity="0.55"
        stroke-width="0.1"
      />
      <defs>
        <filter
          id="filter0_i_2030_452"
          x="0"
          y="0"
          width="154"
          height="154"
          filterUnits="userSpaceOnUse"
          color-interpolation-filters="sRGB"
        >
          <feFlood flood-opacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha"
          />
          <feOffset />
          <feGaussianBlur stdDeviation="1" />
          <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0.901235 0 0 0 0 0.8 0 0 0 0 1 0 0 0 1 0"
          />
          <feBlend mode="normal" in2="shape" result="effect1_innerShadow_2030_452" />
        </filter>
      </defs>
    </svg>
  `,
})
export class CharonGlyph {}
