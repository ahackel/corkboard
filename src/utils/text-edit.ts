// What a markdown editing key returns: the WHOLE new text plus where the selection lands.
export interface TextEdit { text: string; start: number; end: number }

export function lineAt(text: string, pos: number): { from: number; to: number } {
  const from = text.lastIndexOf('\n', pos - 1) + 1;
  const nl = text.indexOf('\n', pos);
  return { from, to: nl < 0 ? text.length : nl };
}
