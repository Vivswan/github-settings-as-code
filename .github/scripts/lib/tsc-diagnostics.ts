/**
 * tsc's `--pretty false` output, read into diagnostics: one `file(line,col): error TSnnnn: message` line each, with the
 * indented lines under it (a chained error's causes) folded into that message. A line that is neither (a crash trace,
 * a config error without a location, a script runner's own output) comes back in `unparsed`; the caller decides
 * whether that refuses the run or is noise around the diagnostics it wanted.
 */

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  code: number;
  message: string;
}

export function parseDiagnostics(output: string): {
  diagnostics: Diagnostic[];
  unparsed: string[];
} {
  const diagnostics: Diagnostic[] = [];
  const unparsed: string[] = [];
  let current: Diagnostic | undefined;
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") {
      continue;
    }
    const match = /^(.+)\((\d+),(\d+)\): error TS(\d+): (.*)$/.exec(line);
    if (match) {
      current = {
        file: match[1] as string,
        line: Number(match[2]),
        column: Number(match[3]),
        code: Number(match[4]),
        message: match[5] as string,
      };
      diagnostics.push(current);
      continue;
    }
    if (/^\s/.test(line) && current) {
      current.message += `\n${line}`;
      continue;
    }
    current = undefined;
    unparsed.push(line);
  }
  return { diagnostics, unparsed };
}
