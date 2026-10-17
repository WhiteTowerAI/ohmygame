import type { CSSProperties } from "react";
import { t } from "./i18n.js";

// Matching cubic segments morph the island into ohmygame-mark-v2.svg at 144px wide.
const ISLAND_OUTLINE =
  "M140 24C146.444 27.222 152.889 30.444 159.333 33.667C165.778 36.889 172.222 40.111 178.667 43.333C185.111 46.556 191.556 49.778 198 53C204.444 56.222 210.889 59.444 217.333 62.667C223.778 65.889 230.222 69.111 236.667 72.333C243.111 75.556 249.556 78.778 256 82C249.556 85.222 243.111 88.444 236.667 91.667C230.222 94.889 223.778 98.111 217.333 101.333C210.889 104.556 204.444 107.778 198 111C191.556 114.222 185.111 117.444 178.667 120.667C172.222 123.889 165.778 127.111 159.333 130.333C152.889 133.556 146.444 136.778 140 140C133.556 136.778 127.111 133.556 120.667 130.333C114.222 127.111 107.778 123.889 101.333 120.667C94.889 117.444 88.444 114.222 82 111C75.556 107.778 69.111 104.556 62.667 101.333C56.222 98.111 49.778 94.889 43.333 91.667C36.889 88.444 30.444 85.222 24 82C31.733 78.133 39.467 74.267 47.2 70.4C54.933 66.533 62.667 62.667 70.4 58.8C78.133 54.933 85.867 51.067 93.6 47.2C101.333 43.333 109.067 39.467 116.8 35.6C124.533 31.733 132.267 27.867 140 24Z";
const LOGO_OUTLINE =
  "M109.149 32C115.467 32 121.631 33.96 126.788 37.61C127.992 38.462 129.196 39.315 130.401 40.167C133.207 42.153 136.561 43.218 139.998 43.219C143.436 43.219 146.792 42.153 149.599 40.167C150.803 39.315 152.007 38.462 153.212 37.61C158.368 33.96 164.533 32 170.851 32C172.321 32 173.79 32 175.26 32C178.17 32 181.111 32.185 183.853 33.157C201.008 39.242 212.81 61.484 211.956 111.938C211.784 122.103 209.405 133.338 200.233 137.725C197.376 139.091 194.022 139.999 190.207 139.999C185.629 139.999 181.989 138.694 179.183 136.855C172.603 132.542 167.782 125.338 160.799 121.716C156.594 119.537 151.924 118.398 147.19 118.398C142.395 118.398 137.601 118.398 132.807 118.398C128.072 118.398 123.405 119.537 119.201 121.716C112.218 125.339 107.394 132.541 100.814 136.855C98.008 138.694 94.371 139.999 89.793 139.999C85.977 139.998 82.625 139.091 79.767 137.725C70.596 133.338 68.215 122.103 68.043 111.938C67.19 61.486 78.993 39.242 96.147 33.157C98.889 32.185 101.83 32 104.739 32C106.209 32 107.679 32 109.149 32Z";

export function OnboardingDemo() {
  return (
    <div
      className="onboarding-demo"
      role="img"
      aria-label={t("onboarding.animation")}
      style={
        {
          "--demo-island-outline": `path("${ISLAND_OUTLINE}")`,
          "--demo-logo-outline": `path("${LOGO_OUTLINE}")`,
        } as CSSProperties
      }
    >
      <svg
        className="onboarding-demo-play"
        viewBox="0 0 400 180"
        aria-hidden="true"
      >
        <svg x="60" y="0" width="280" height="170" viewBox="0 0 280 170">
          <g className="onboarding-demo-world">
            <DemoWorld />
          </g>
        </svg>
        <text
          className="onboarding-demo-wordmark"
          x="168"
          y="32"
          dominantBaseline="central"
        >
          OhMyGame
        </text>
      </svg>
    </div>
  );
}

function DemoWorld() {
  return (
    <>
      <g className="onboarding-demo-base">
        <ellipse
          className="onboarding-demo-shadow"
          cx="140"
          cy="136"
          rx="108"
          ry="18"
        />
        <path
          className="onboarding-demo-earth"
          d="M24 82L140 140L256 82V95L140 153L24 95Z"
        />
      </g>
      <path className="onboarding-demo-morph" d={LOGO_OUTLINE} />
      <g className="onboarding-demo-scenery">
        <g className="onboarding-demo-terrain">
          <path
            className="onboarding-demo-earth"
            d="M132 62L164 46L196 62V70L164 86L132 70Z"
          />
          <path
            className="onboarding-demo-hill"
            d="M132 62L164 46L196 62L164 78Z"
          />
        </g>
        <path
          className="onboarding-demo-path"
          d="M70 59C90 75 130 69 143 83S166 106 206 116"
        />
        <path
          className="onboarding-demo-water"
          d="M159 73C172 67 193 77 206 89C215 98 199 106 181 106C163 107 155 99 150 94C144 86 148 78 159 73Z"
        />
        {["128 45", "84 60", "213 83", "111 106"].map((position, index) => (
          <g
            key={position}
            className="onboarding-demo-tree-piece"
            style={
              { "--tree-delay": `${0.55 + index * 0.3}s` } as CSSProperties
            }
          >
            <g transform={`translate(${position})`}>
              <path className="onboarding-demo-trunk" d="M0 -5V8" />
              <path
                className="onboarding-demo-tree"
                d="M0 -34L-13 -9Q0 -2 13 -9Z"
              />
              <path
                className="onboarding-demo-tree-top"
                d="M0 -34L-9 -17Q0 -12 9 -17Z"
              />
            </g>
          </g>
        ))}
        <g className="onboarding-demo-stones">
          <ellipse cx="88" cy="102" rx="6" ry="3" />
          <ellipse cx="99" cy="107" rx="4" ry="2" />
          <ellipse cx="164" cy="62" rx="4" ry="2" />
        </g>
      </g>
      <g
        className="onboarding-demo-logo-details"
        transform="translate(68 32) scale(0.66977) translate(-25 -15)"
      >
        <circle cx="86.2234" cy="76.3749" r="11.9928" />
        <rect
          x="174.758"
          y="56.2189"
          width="11.892"
          height="36.7846"
          rx="5.946"
        />
        <rect
          x="162.312"
          y="68.6652"
          width="36.784"
          height="11.892"
          rx="5.946"
        />
      </g>
    </>
  );
}
