// FSA can't watch files, so focus and tab-visible stand in for "may have changed". Wired once.
let _onExternalChange: (() => void) | null = null, _watchInstalled = false;
export function installWatch(cb: () => void): void {
  _onExternalChange = cb;
  if (_watchInstalled) {
    return;
  }
  _watchInstalled = true;
  const fire = () => _onExternalChange && _onExternalChange();
  window.addEventListener('focus', fire);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      fire();
    }
  });
}
