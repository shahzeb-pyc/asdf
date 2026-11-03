/**
 * Test-only FixedLengthStream. Node has no FixedLengthStream (workerd
 * does), so tests install this exact-count shim: bytes pass through,
 * and closing with fewer — or writing more — bytes than declared
 * fails. That is the behavior the production R2 put relies on, so
 * installing it here lets the tests prove streamToR2 hands the put a
 * known-length stream instead of the raw wrapped one. Never imported
 * by production code: the Worker uses the platform global.
 */
class TestFixedLengthStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  constructor(expectedBytes: number) {
    let written = 0;
    const inner = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        written += chunk.length;
        if (written > expectedBytes) {
          controller.error(new Error(`FixedLengthStream: wrote ${written} bytes, expected ${expectedBytes}`));
          return;
        }
        controller.enqueue(chunk);
      },
      flush(controller) {
        if (written !== expectedBytes) {
          controller.error(new Error(`FixedLengthStream: wrote ${written} bytes, expected ${expectedBytes}`));
        }
      },
    });
    this.readable = inner.readable;
    this.writable = inner.writable;
  }
}

export function installFixedLengthStreamShim(): void {
  if ((globalThis as Record<string, unknown>).FixedLengthStream === undefined) {
    (globalThis as Record<string, unknown>).FixedLengthStream = TestFixedLengthStream;
  }
}
