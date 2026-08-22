import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Logo Charon complet (icône colorée avec dégradés/lueurs).
 * Illustration de marque autonome — dimensionnée par le parent (le SVG
 * remplit 100 % de l'hôte). Réutilisable hors de la page de connexion.
 *
 * Remarque : les identifiants de <defs> (filtres/masques) sont globaux ;
 * n'afficher qu'une instance à la fois par écran pour éviter toute collision.
 */
@Component({
  selector: 'app-charon-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: block;
      line-height: 0;
    }
    svg {
      display: block;
      width: 100%;
      height: 100%;
    }
  `,
  template: `
    <svg viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g filter="url(#filter0_i_2021_337)">
        <g clip-path="url(#clip0_2021_337)">
          <rect width="256" height="256" rx="40" fill="#001124" />
          <g filter="url(#filter1_f_2021_337)">
            <ellipse
              cx="126.5"
              cy="241"
              rx="69"
              ry="137.5"
              transform="rotate(-90 126.5 241)"
              fill="#134E91"
            />
          </g>
          <g filter="url(#filter2_f_2021_337)" style="mix-blend-mode:plus-lighter">
            <ellipse
              cx="127.5"
              cy="271.816"
              rx="38.1836"
              ry="142.871"
              transform="rotate(-90 127.5 271.816)"
              fill="#59A5FB"
            />
          </g>
          <g filter="url(#filter3_i_2021_337)">
            <path
              d="M51 201.391C51 203.384 52.616 205 54.6094 205H201.391C203.384 205 205 203.384 205 201.391V165.207C205 162.535 202.202 160.797 199.847 162.058C182.409 171.398 166.858 183.801 153.914 198.548C152.452 200.213 149.853 200.247 148.348 198.621C136.793 186.132 123.317 175.445 108.39 167.031C106.884 166.183 106.161 164.403 106.647 162.744C115.915 131.125 115.361 96.8956 105.174 65.5996C104.055 62.1614 108.204 58.8443 111.312 60.6926C138.433 76.824 170.022 84.8462 201.602 83.6413C203.511 83.5684 205 81.9844 205 80.0738V54.6094C205 52.616 203.384 51 201.391 51H54.6094C52.616 51 51 52.616 51 54.6094V201.391Z"
              fill="#E5EDF5"
            />
          </g>
          <path
            d="M54.6094 51.0498H201.391C203.356 51.0498 204.95 52.6436 204.95 54.6094V80.0742C204.95 81.9584 203.481 83.519 201.6 83.5908C170.029 84.7954 138.45 76.7757 111.337 60.6494C109.761 59.7125 107.925 60.0872 106.627 61.125C105.329 62.1629 104.56 63.8719 105.127 65.6152C115.31 96.9016 115.864 131.121 106.599 162.729C106.106 164.411 106.839 166.215 108.365 167.075C123.288 175.486 136.76 186.17 148.312 198.655C149.836 200.303 152.47 200.268 153.951 198.581C166.892 183.838 182.438 171.439 199.87 162.103C202.19 160.86 204.95 162.572 204.95 165.207V201.391C204.95 203.356 203.356 204.95 201.391 204.95H54.6094C52.6436 204.95 51.0498 203.356 51.0498 201.391V54.6094C51.0498 52.6436 52.6436 51.0498 54.6094 51.0498Z"
            stroke="white"
            stroke-width="0.1"
          />
          <mask
            id="mask0_2021_337"
            style="mask-type:alpha"
            maskUnits="userSpaceOnUse"
            x="51"
            y="51"
            width="154"
            height="154"
          >
            <path
              d="M54.6094 51.5H201.391C203.108 51.5 204.5 52.8921 204.5 54.6094V80.0742C204.5 81.7226 203.217 83.0792 201.583 83.1416C170.099 84.3429 138.605 76.3446 111.567 60.2627C109.795 59.2083 107.755 59.647 106.346 60.7734C104.937 61.8998 104.061 63.7928 104.699 65.7539C114.855 96.9544 115.407 131.081 106.167 162.603C105.615 164.485 106.436 166.504 108.145 167.467C123.026 175.855 136.461 186.509 147.981 198.961C149.688 200.805 152.632 200.766 154.289 198.878C167.194 184.175 182.699 171.81 200.083 162.499C202.092 161.423 204.5 162.899 204.5 165.207V201.391C204.5 203.108 203.108 204.5 201.391 204.5H54.6094C52.8921 204.5 51.5 203.108 51.5 201.391V54.6094C51.5 52.8921 52.8921 51.5 54.6094 51.5Z"
              fill="#E5EDF5"
              stroke="white"
            />
          </mask>
          <g mask="url(#mask0_2021_337)">
            <g filter="url(#filter4_f_2021_337)" style="mix-blend-mode:plus-lighter">
              <ellipse cx="18" cy="114" rx="40" ry="63" fill="white" />
            </g>
            <g opacity="0.6" filter="url(#filter5_f_2021_337)" style="mix-blend-mode:plus-darker">
              <ellipse
                cx="187.5"
                cy="128"
                rx="49"
                ry="83.5"
                transform="rotate(-90 187.5 128)"
                fill="#9ECBFF"
              />
            </g>
            <g opacity="0.5" filter="url(#filter6_f_2021_337)" style="mix-blend-mode:plus-lighter">
              <ellipse
                cx="187.5"
                cy="128"
                rx="49"
                ry="83.5"
                transform="rotate(-90 187.5 128)"
                fill="#9ECBFF"
              />
            </g>
          </g>
          <g filter="url(#filter7_f_2021_337)" style="mix-blend-mode:plus-lighter">
            <path
              d="M112 267L-25 67L-25 102.94L69.8716 239.379L-25 139.879L-25 267L28.7385 267L17.1283 237.715L36.368 267L112 267Z"
              fill="#59A5FB"
            />
          </g>
          <g filter="url(#filter8_f_2021_337)" style="mix-blend-mode:plus-lighter">
            <path
              d="M210.323 22.6667L271 73.2537L271 -32L151 -32L253.935 97.4594L217.637 59.655L271 132L271 85.7645L210.323 22.6667Z"
              fill="#59A5FB"
            />
          </g>
        </g>
      </g>
      <rect
        x="1"
        y="1"
        width="254"
        height="254"
        rx="39"
        stroke="white"
        style="mix-blend-mode:overlay"
        stroke-width="2"
      />
      <defs>
        <filter
          id="filter0_i_2021_337"
          x="0"
          y="0"
          width="256"
          height="256"
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
          <feGaussianBlur stdDeviation="2" />
          <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0.301904 0 0 0 0 0.44108 0 0 0 0 0.60014 0 0 0 1 0"
          />
          <feBlend mode="normal" in2="shape" result="effect1_innerShadow_2021_337" />
        </filter>
        <filter
          id="filter1_f_2021_337"
          x="-71"
          y="112"
          width="395"
          height="258"
          filterUnits="userSpaceOnUse"
          color-interpolation-filters="sRGB"
        >
          <feFlood flood-opacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="30" result="effect1_foregroundBlur_2021_337" />
        </filter>
        <filter
          id="filter2_f_2021_337"
          x="-79.3711"
          y="169.633"
          width="413.742"
          height="204.367"
          filterUnits="userSpaceOnUse"
          color-interpolation-filters="sRGB"
        >
          <feFlood flood-opacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="32" result="effect1_foregroundBlur_2021_337" />
        </filter>
        <filter
          id="filter3_i_2021_337"
          x="51"
          y="51"
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
          <feBlend mode="normal" in2="shape" result="effect1_innerShadow_2021_337" />
        </filter>
        <filter
          id="filter4_f_2021_337"
          x="-72"
          y="1"
          width="180"
          height="226"
          filterUnits="userSpaceOnUse"
          color-interpolation-filters="sRGB"
        >
          <feFlood flood-opacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="25" result="effect1_foregroundBlur_2021_337" />
        </filter>
        <filter
          id="filter5_f_2021_337"
          x="64"
          y="39"
          width="247"
          height="178"
          filterUnits="userSpaceOnUse"
          color-interpolation-filters="sRGB"
        >
          <feFlood flood-opacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="20" result="effect1_foregroundBlur_2021_337" />
        </filter>
        <filter
          id="filter6_f_2021_337"
          x="64"
          y="39"
          width="247"
          height="178"
          filterUnits="userSpaceOnUse"
          color-interpolation-filters="sRGB"
        >
          <feFlood flood-opacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="20" result="effect1_foregroundBlur_2021_337" />
        </filter>
        <filter
          id="filter7_f_2021_337"
          x="-105"
          y="-13"
          width="297"
          height="360"
          filterUnits="userSpaceOnUse"
          color-interpolation-filters="sRGB"
        >
          <feFlood flood-opacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="40" result="effect1_foregroundBlur_2021_337" />
        </filter>
        <filter
          id="filter8_f_2021_337"
          x="91"
          y="-92"
          width="240"
          height="284"
          filterUnits="userSpaceOnUse"
          color-interpolation-filters="sRGB"
        >
          <feFlood flood-opacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="30" result="effect1_foregroundBlur_2021_337" />
        </filter>
        <clipPath id="clip0_2021_337">
          <rect width="256" height="256" rx="40" fill="white" />
        </clipPath>
      </defs>
    </svg>
  `,
})
export class CharonLogo {}
