/** Reading vitest's JSON reports for test-vscode.ts: which files failed, and which of those passed on their retry. */

/** The parts of vitest's JSON report these read. */
export type Report = {
  readonly testResults: readonly {
    readonly name: string;
    readonly status: string;
    readonly message?: string;
    readonly assertionResults: readonly { readonly fullName: string; readonly status: string; readonly failureMessages: readonly string[] }[];
  }[];
};

export type Flake = { readonly file: string; readonly test: string; readonly firstFailure: string };

export const failedFiles = (report: Report): string[] => report.testResults.filter((r) => r.status !== 'passed').map((r) => r.name);

/** Files that failed in `first` and passed in `retry`, each with its first failing test and that failure's first line. */
export function flakesOf(first: Report, retry: Report): Flake[] {
  const passed = new Set(retry.testResults.filter((r) => r.status === 'passed').map((r) => r.name));
  return first.testResults
    .filter((r) => r.status !== 'passed' && passed.has(r.name))
    .map((r) => {
      const test = r.assertionResults.find((a) => a.status === 'failed');
      const message = test?.failureMessages[0] ?? r.message ?? 'the file failed';
      return { file: r.name, test: test?.fullName ?? '', firstFailure: message.split('\n')[0]!.slice(0, 300) };
    });
}
