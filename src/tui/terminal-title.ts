interface TerminalTitleOutput {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

/** OSC payload must not let user-controlled session names inject terminal commands. */
export function sanitizeTerminalTitle(title: string): string {
  return title.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim();
}

export function formatTerminalTabTitle(title: string, forked: boolean): string {
  return forked ? `fork: ${title}` : title;
}

/** OSC 1 sets the terminal icon name, which Otty uses as the tab name. */
export function setTerminalTabTitle(
  title: string,
  output: TerminalTitleOutput = process.stdout,
): void {
  if (!output.isTTY) return;
  const safeTitle = sanitizeTerminalTitle(title);
  if (!safeTitle) return;
  output.write(`\x1b]1;${safeTitle}\x1b\\`);
}
