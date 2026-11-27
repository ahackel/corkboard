// Motion OFF is for the e2e specs only (`window.corkboardMotion = false` before boot); CSS follows via
// `html[data-motion="off"]`. No setting offers it: the motion is how a fold or a fan reads.
export const MOTION = (window as Window & { corkboardMotion?: boolean }).corkboardMotion !== false;

export function installMotionSwitch(): void {
  if (!MOTION) {
    document.documentElement.dataset.motion = 'off';
  }
}
