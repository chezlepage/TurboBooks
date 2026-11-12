import fs from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Sends a file with HTTP Range support so the browser can seek. */
export async function sendFileWithRange(
  request: FastifyRequest,
  reply: FastifyReply,
  file: string,
  contentType: string,
): Promise<FastifyReply> {
  let size: number;
  try {
    size = (await fs.promises.stat(file)).size;
  } catch {
    return reply.code(404).send({ error: 'File missing on disk' });
  }

  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Type', contentType);
  reply.header('Cache-Control', 'private, max-age=3600');

  const range = request.headers.range;
  if (!range) {
    reply.header('Content-Length', size);
    return reply.send(fs.createReadStream(file));
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let start: number;
  let end: number;
  if (match && (match[1] || match[2])) {
    if (match[1]) {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    } else {
      // Suffix range: last N bytes.
      start = Math.max(0, size - Number(match[2]));
      end = size - 1;
    }
  } else {
    start = NaN;
    end = NaN;
  }

  if (!Number.isFinite(start) || start > end || start >= size) {
    reply.header('Content-Range', `bytes */${size}`);
    return reply.code(416).send();
  }

  reply.code(206);
  reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
  reply.header('Content-Length', end - start + 1);
  return reply.send(fs.createReadStream(file, { start, end }));
}
