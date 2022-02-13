import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import debug from "debug";
import codeFrame from "@parcel/codeframe";
import wordWrap from "word-wrap";

/**
 * Produce error message, optionally printing relevant code locations.
 */
export function error(message: string, locs: CodeLoc[] = []) {
  if (debug.enabled("asap:error")) {
    let msg = makeError(message, locs);
    console.log(msg);
  }
}

export type CodeLoc = {
  /** An absolute path to the file with the source code. */
  path: string;
  line: number;
  column: number;
  message: string;
};

function makeError(message: string, locs: CodeLoc[]): string {
  let terminalWidth = process.stdout.columns;
  let lines = [];
  lines.push(`  ${chalk.redBright("asap:error")} ${wrapMessage(message, 13)}`);
  for (let loc of locs) {
    let code = fs.readFileSync(loc.path, "utf8");
    let message = wrapMessage(loc.message, loc.column + 8);
    let filePath = path.relative(process.cwd(), loc.path);
    lines.push(`  At ${filePath}:${loc.line}:${loc.column}`);
    lines.push(
      codeFrame(
        code,
        [
          {
            message,
            start: { line: loc.line, column: loc.column },
            end: { line: loc.line, column: loc.column },
          },
        ],
        {
          useColor: true,
          terminalWidth,
        }
      )
    );
  }
  return lines.join("\n");
}

function wrapMessage(message: string, indent: number) {
  let indentString = "".padStart(indent, " ");
  message = wordWrap(message, {
    width: process.stdout.columns - indent,
    indent: indentString,
  });
  message = message.trimStart();
  return message;
}
