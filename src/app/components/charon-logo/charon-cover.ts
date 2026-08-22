import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Fond de la cover de marque Charon (458×600) : navy + lueurs bleues, sans
 * texte ni glyphe. Le glyphe et le texte sont composés par-dessus en HTML
 * (page de connexion) pour pouvoir organiser l'intérieur librement.
 *
 * Coins arrondis alignés sur 16px (cohérent avec le panneau de droite).
 * Les identifiants de <defs> sont globaux : une seule instance par écran.
 */
@Component({
  selector: 'app-charon-cover',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: block;
      width: 100%;
      height: 100%;
      line-height: 0;
    }
    svg {
      display: block;
      width: 100%;
      height: 100%;
    }
  `,
  template: `
    <svg
      viewBox="0 0 458 600"
      preserveAspectRatio="xMidYMid slice"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g filter="url(#filter0_i_2027_352)">
        <g clip-path="url(#clip0_2027_352)">
          <rect width="458" height="600" rx="16" fill="#001124" />
          <g clip-path="url(#clip1_2027_352)">
            <g filter="url(#filter1_f_2027_352)">
              <ellipse cx="229" cy="717" rx="456" ry="250" fill="#134E91" />
            </g>
            <g filter="url(#filter2_f_2027_352)" style="mix-blend-mode:plus-lighter">
              <ellipse cx="229" cy="695" rx="348" ry="150" fill="#59A5FB" />
            </g>
            <g filter="url(#filter3_f_2027_352)" style="mix-blend-mode:plus-lighter">
              <ellipse cx="229.5" cy="679.5" rx="200.5" ry="81.5" fill="#BFDCFD" />
            </g>
          </g>
        </g>
      </g>
      <rect
        x="0.5"
        y="0.5"
        width="457"
        height="599"
        rx="15.5"
        stroke="white"
        style="mix-blend-mode:overlay"
      />
      <defs>
        <filter
          id="filter0_i_2027_352"
          x="0"
          y="0"
          width="458"
          height="600"
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
          <feGaussianBlur stdDeviation="5" />
          <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0.301904 0 0 0 0 0.44108 0 0 0 0 0.60014 0 0 0 1 0"
          />
          <feBlend mode="normal" in2="shape" result="effect1_innerShadow_2027_352" />
        </filter>
        <filter
          id="filter1_f_2027_352"
          x="-327"
          y="367"
          width="1112"
          height="700"
          filterUnits="userSpaceOnUse"
          color-interpolation-filters="sRGB"
        >
          <feFlood flood-opacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="50" result="effect1_foregroundBlur_2027_352" />
        </filter>
        <filter
          id="filter2_f_2027_352"
          x="-219"
          y="445"
          width="896"
          height="500"
          filterUnits="userSpaceOnUse"
          color-interpolation-filters="sRGB"
        >
          <feFlood flood-opacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="50" result="effect1_foregroundBlur_2027_352" />
        </filter>
        <filter
          id="filter3_f_2027_352"
          x="-71"
          y="498"
          width="601"
          height="363"
          filterUnits="userSpaceOnUse"
          color-interpolation-filters="sRGB"
        >
          <feFlood flood-opacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="50" result="effect1_foregroundBlur_2027_352" />
        </filter>
        <clipPath id="clip0_2027_352">
          <rect width="458" height="600" rx="16" fill="white" />
        </clipPath>
        <clipPath id="clip1_2027_352">
          <rect width="458" height="502" fill="white" transform="translate(0 248)" />
        </clipPath>
      </defs>
    </svg>
  `,
})
export class CharonCover {}
