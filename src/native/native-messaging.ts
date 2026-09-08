import { endianness } from 'node:os';
import { failure } from '../protocol.ts';
import type { Response } from '../protocol.ts';

const littleEndian = endianness() === 'LE';
let sent = false;
process.stdout.on('error', () => process.exit(1));
export function send(value: Response) {
  if (sent) return;
  sent = true;
  let body = Buffer.from(JSON.stringify(value));
  if (body.length > 1024 * 1024) body = Buffer.from(JSON.stringify(failure('TEMPORARY_FAILURE')));
  const header = Buffer.alloc(4);
  if (littleEndian) {
    header.writeUInt32LE(body.length);
  } else {
    header.writeUInt32BE(body.length);
  }
  process.stdout.end(Buffer.concat([header, body]));
}
function isRequestFrameLength(length: number): boolean {
  return length > 0 && length <= 16384;
}

export async function respondToNativeMessage(handleBody: (body: Buffer) => Promise<Response>) {
  let buffer = Buffer.alloc(0);
  const timer = setTimeout(() => {
    send(failure('INVALID_REQUEST'));
    process.stdin.destroy();
  }, 5000);
  try {
    // sendNativeMessage starts one process per request; accept exactly one bounded frame.
    for await (const chunk of process.stdin) {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 16388) {
        send(failure('INVALID_REQUEST'));
        return;
      }
      if (buffer.length < 4) continue;
      const length = littleEndian ? buffer.readUInt32LE() : buffer.readUInt32BE();
      if (!isRequestFrameLength(length)) {
        send(failure('INVALID_REQUEST'));
        return;
      }
      if (buffer.length < length + 4) continue;
      clearTimeout(timer);
      if (buffer.length !== length + 4) {
        send(failure('INVALID_REQUEST'));
        return;
      }
      send(await handleBody(buffer.subarray(4)));
      return;
    }
    send(failure('INVALID_REQUEST'));
  } finally {
    clearTimeout(timer);
    process.stdin.destroy();
  }
}
