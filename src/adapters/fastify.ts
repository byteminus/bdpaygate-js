/**
 * Fastify 4 and 5.
 *
 *     import { bdpaygate } from 'bdpaygate/fastify';
 *     await app.register(bdpaygate, { pay });
 *
 * Registers GET and POST `${prefix}/:gateway/:outcome` and parses
 * form bodies for those routes, without needing @fastify/formbody.
 */
import { parseBody, parseParams } from '../core/handler.js';
import type { BdPayGate } from '../core/manager.js';
import type { JsonObject } from '../core/types.js';

interface FastifyRequestLike {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  params: unknown;
  body: unknown;
  ip?: string;
}

interface FastifyReplyLike {
  code(status: number): FastifyReplyLike;
  headers(values: Record<string, string>): FastifyReplyLike;
  send(body?: string | null): unknown;
}

type ContentTypeParser = (
  request: unknown,
  body: string,
  done: (error: Error | null, body?: unknown) => void,
) => void;

interface FastifyInstanceLike {
  route(options: {
    method: string[];
    url: string;
    handler: (request: FastifyRequestLike, reply: FastifyReplyLike) => Promise<unknown>;
  }): unknown;
  hasContentTypeParser?(contentType: string): boolean;
  addContentTypeParser(
    contentType: string,
    options: { parseAs: 'string' },
    parser: ContentTypeParser,
  ): unknown;
}

export interface BdPayGateFastifyOptions {
  pay: BdPayGate;
}

function flat(headers: FastifyRequestLike['headers']): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
      .map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v]),
  );
}

export async function bdpaygate(
  fastify: FastifyInstanceLike,
  options: BdPayGateFastifyOptions,
): Promise<void> {
  const { pay } = options;
  const form = 'application/x-www-form-urlencoded';

  // Encapsulated: this parser applies only to the routes in this plugin.
  if (!fastify.hasContentTypeParser?.(form)) {
    fastify.addContentTypeParser(form, { parseAs: 'string' }, (_request, body, done) => {
      done(null, parseBody(form, body));
    });
  }

  fastify.route({
    method: ['GET', 'POST'],
    url: `${pay.prefix}/:gateway/:outcome`,
    handler: async (request, reply) => {
      const params = (request.params ?? {}) as { gateway?: string; outcome?: string };
      const url = new URL(request.url, 'http://localhost');
      const body =
        request.body !== null && typeof request.body === 'object'
          ? (request.body as JsonObject)
          : typeof request.body === 'string'
            ? parseBody(String(request.headers['content-type'] ?? ''), request.body)
            : {};

      const response = await pay.handleCallback(params.gateway ?? '', params.outcome ?? '', {
        method: request.method,
        query: parseParams(url.searchParams),
        body,
        headers: flat(request.headers),
        clientIp: request.ip,
      });

      return reply.code(response.status).headers(response.headers).send(response.body);
    },
  });
}

export { bdpaygate as fastifyBdPayGate };
