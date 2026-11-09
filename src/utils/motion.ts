// Motion can be switched OFF, for the e2e specs only: they set `window.corkboardMotion = false` before
// boot (e2e/helpers.ts openBoard), and every glide, fold and fade then lands at once — the JS-timed ones
// through MOTION here, the CSS ones through `html[data-motion="off"]` (styles.css). No setting offers it:
// the motion is how a fold or a fan reads, so the app itself always plays it.
export const MOTION = (window as Window & { corkboardMotion?: boolean }).corkboardMotion !== false;

if (!MOTION) {
  document.documentElement.dataset.motion = 'off';
}
