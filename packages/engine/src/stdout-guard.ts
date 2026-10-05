// Portions ported from Pi (https://github.com/earendil-works/pi) at b2b5c42, Copyright (c) 2025 Mario Zechner, MIT License.

type Out = Pick<NodeJS.WriteStream, 'write'>;

/**
 * Gives stdout to the protocol alone. Afterwards anything else written to `stdout`, such as a dependency's stray
 * `console.log`, goes to `stderr`, where the editor shows it in the output channel instead of reading it as a broken
 * frame. Returns the one stream that still reaches the real stdout.
 */
export function guardStdout(stdout: Out = process.stdout, stderr: Out = process.stderr): WritableStream<Uint8Array> {
  const raw = stdout.write.bind(stdout) as (chunk: Uint8Array, callback: (error?: Error | null) => void) => boolean;
  stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) =>
    (stderr.write as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean)(chunk, ...rest)) as Out['write'];
  return new WritableStream<Uint8Array>({
    write: (chunk) => new Promise<void>((resolve, reject) => void raw(chunk, (error) => (error ? reject(error) : resolve()))),
  });
}
