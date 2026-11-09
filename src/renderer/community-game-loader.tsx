import { useEffect, useRef, useState } from "react";

// The website's game player loading screen (ohmygame-web, scripts/pad-loader.ts
// and pad-dots.ts), drawn in the player's box rather than the whole window.
// While a game loads, the controller's dots fly together and a band of light
// crosses them; then they scatter to show the game.

const PAD_PATH = "M94.436 59C103.87 59 113.072 61.9271 120.773 67.377L126.168 71.1953C130.359 74.1608 135.366 75.7529 140.499 75.7529C145.634 75.7529 150.641 74.161 154.831 71.1953L160.227 67.377C167.927 61.9271 177.129 59 186.562 59H193.146C197.491 59 201.88 59.2743 205.975 60.7266C231.589 69.8111 249.208 103.021 247.934 178.353C247.677 193.53 244.125 210.306 230.431 216.854C226.163 218.895 221.16 220.25 215.462 220.25C208.626 220.25 203.196 218.301 199.005 215.555C189.181 209.115 181.982 198.361 171.554 192.954C165.276 189.699 158.308 188 151.238 188H129.761C122.691 188 115.723 189.699 109.446 192.954C99.018 198.361 91.8189 209.113 81.9946 215.555C77.8039 218.301 72.3737 220.25 65.5366 220.25C59.8388 220.25 54.8353 218.895 50.5678 216.854C36.8732 210.306 33.3216 193.53 33.0649 178.353C31.7905 103.022 49.4091 69.8111 75.0229 60.7266C79.1179 59.2743 83.5071 59 87.852 59H94.436Z";
const PAD_BOX = { x: 33, y: 59, width: 215, height: 161 };
const COLUMNS = 52;
/** So a game that loads at once doesn't just flash the logo. */
const SHORTEST_MS = 900;
const SCATTER_MS = 450;

interface PadDot { x: number; y: number; shade: number }
let padDots: PadDot[] | undefined;

/** The controller's dots on a staggered grid, in the coordinates of PAD_BOX. */
function controllerDots(): PadDot[] {
  if (padDots) return padDots;
  const test = typeof Path2D === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!test) return [];
  const body = new Path2D(PAD_PATH);
  const { x: left, y: top, width, height } = PAD_BOX;
  const unit = width / COLUMNS;
  const dots: PadDot[] = [];
  for (let gy = top, row = 0; gy < top + height + 1; gy += unit, row++) {
    for (let gx = left; gx < left + width + 1; gx += unit) {
      const x = gx + (row % 2 ? unit / 2 : 0);
      const y = gy;
      if (!test.isPointInPath(body, x, y)) continue;
      // The stick and the cross stay open.
      if (Math.hypot(x - 94.2, y - 120.4) < 13) continue;
      if ((Math.abs(x - 188.7) < 7 && Math.abs(y - 118.6) < 19.5) || (Math.abs(x - 188.7) < 19.5 && Math.abs(y - 118.6) < 7)) continue;
      // Halftone shade: bright at the top left, sparse towards the bottom right, like light on a shell.
      dots.push({ x, y, shade: clamp(1.08 - ((x - left) / width) * 0.35 - ((y - top) / height) * 0.75) });
    }
  }
  return (padDots = dots);
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const ease = (value: number) => value * value * (3 - 2 * value);
const lerp = (from: number, to: number, amount: number) => from + (to - from) * amount;

function createPadLoader(root: HTMLElement, canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  // Without a canvas to draw on (tests), the loader only shows and hides.
  if (!context) {
    const hide = () => { root.hidden = true; };
    return { start: () => { root.hidden = false; }, finish: hide, stop: hide };
  }
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let dots: { hx: number; hy: number; sx: number; sy: number; shade: number; delay: number }[] = [];
  let width = 0, height = 0, left = 0, drawn = 0, unit = 0, nameY = 0, fontFamily = "sans-serif";
  let frame = 0, timer = 0, startedAt = 0, leavingAt = 0, running = false;
  let resize: ResizeObserver | undefined;

  const seed = () => {
    width = root.clientWidth;
    height = root.clientHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    fontFamily = getComputedStyle(canvas).fontFamily || fontFamily;
    drawn = Math.min(width * 0.36, 164);
    const scale = drawn / PAD_BOX.width;
    unit = (PAD_BOX.width / COLUMNS) * scale;
    left = width / 2 - drawn / 2;
    const top = height / 2 - (PAD_BOX.height * scale) / 2 - 26;
    nameY = top + PAD_BOX.height * scale + 50;
    dots = controllerDots().map(({ x, y, shade }) => {
      const angle = Math.random() * Math.PI * 2;
      const far = Math.max(width, height) * (0.35 + Math.random() * 0.4);
      return {
        hx: left + (x - PAD_BOX.x) * scale,
        hy: top + (y - PAD_BOX.y) * scale,
        shade,
        delay: Math.random(),
        sx: width / 2 + Math.cos(angle) * far,
        sy: height / 2 + Math.sin(angle) * far,
      };
    });
  };

  const draw = (now: number) => {
    const leaving = leavingAt ? clamp((now - leavingAt) / SCATTER_MS) : 0;
    if (leaving === 1) {
      stop();
      return;
    }
    frame = requestAnimationFrame(draw);
    const reduced = Boolean(still?.matches);
    const elapsed = reduced ? 2 : (now - startedAt) / 1000;
    const band = ((elapsed * 0.6) % 1.5) - 0.25;
    context.clearRect(0, 0, width, height);
    context.fillStyle = "rgb(236 236 236)";
    for (const dot of dots) {
      const gathered = ease(clamp(elapsed / 0.7 - dot.delay * 0.45));
      const gone = reduced ? 0 : ease(clamp(leaving * 1.5 - dot.delay * 0.5));
      const x = lerp(lerp(dot.sx, dot.hx, gathered), dot.sx, gone);
      const y = lerp(lerp(dot.sy, dot.hy, gathered), dot.sy, gone);
      const light = reduced ? 0 : Math.exp(-(((dot.hx - left) / drawn - band) ** 2) / 0.012);
      const size = lerp(unit * (0.28 + dot.shade * 0.62), unit * 0.92, light);
      context.globalAlpha = lerp(0.34 + dot.shade * 0.66, 1, light) * gathered * (1 - gone);
      context.fillRect(x - size / 2, y - size / 2, size, size);
    }
    context.globalAlpha = ease(clamp((elapsed - 0.5) / 0.4)) * (1 - leaving);
    context.font = `600 24px ${fontFamily}`;
    context.textAlign = "center";
    context.fillText("OhMyGame", width / 2, nameY);
    context.globalAlpha = 1;
  };

  function stop() {
    running = false;
    cancelAnimationFrame(frame);
    window.clearTimeout(timer);
    resize?.disconnect();
    resize = undefined;
    root.hidden = true;
    root.classList.remove("is-leaving");
    leavingAt = 0;
  }

  return {
    stop,
    start() {
      stop();
      root.hidden = false;
      seed();
      if (typeof ResizeObserver !== "undefined") {
        resize = new ResizeObserver(seed);
        resize.observe(root);
      }
      startedAt = performance.now();
      running = true;
      frame = requestAnimationFrame(draw);
    },
    finish() {
      if (!running || leavingAt) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        leavingAt = performance.now();
        root.classList.add("is-leaving");
      }, Math.max(0, SHORTEST_MS - (performance.now() - startedAt)));
    },
  };
}

/** Covers the player until `loading` turns false, then scatters away. */
export function GameLoader({ loading }: { loading: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const loader = useRef<ReturnType<typeof createPadLoader>>(undefined);
  // React sets this once; the loader shows and hides itself after that.
  const [startHidden] = useState(!loading);

  useEffect(() => {
    const current = createPadLoader(root.current!, canvas.current!);
    loader.current = current;
    return () => {
      current.stop();
      loader.current = undefined;
    };
  }, []);

  useEffect(() => {
    if (loading) loader.current?.start();
    else loader.current?.finish();
  }, [loading]);

  return (
    <div ref={root} className="community-loader" aria-hidden="true" hidden={startHidden}>
      <canvas ref={canvas} />
    </div>
  );
}
