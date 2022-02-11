declare module "@parcel/codeframe" {
  export type CodeFramePadding = {
    before: number;
    after: number;
  };

  export type CodeFrameOptionsInput = Partial<CodeFrameOptions>;

  export type CodeFrameOptions = {
    useColor: boolean;
    syntaxHighlighting: boolean;
    maxLines: number;
    padding: CodeFramePadding;
    terminalWidth: number;
    language?: string;
  };

  /**
   * These positions are 1-based (so <code>1</code> is the first line/column)
   */
  export type DiagnosticHighlightLocation = {
    line: number;
    column: number;
  };

  export type DiagnosticSeverity = "error" | "warn" | "info";

  /**
   * Note: A tab character is always counted as a single character
   * This is to prevent any mismatch of highlighting across machines
   */
  export type DiagnosticCodeHighlight = {
    /**
     * Location of the first character that should get highlighted for this
     * highlight.
     */
    start: DiagnosticHighlightLocation;
    /**
     * Location of the last character that should get highlighted for this
     * highlight.
     */
    end: DiagnosticHighlightLocation;
    /**
     * A message that should be displayed at this location in the code
     * (optional).
     */
    message?: string;
  };

  export default function codeFrame(
    code: string,
    highlights: Array<DiagnosticCodeHighlight>,
    inputOpts: CodeFrameOptionsInput = {}
  ): string;
}
