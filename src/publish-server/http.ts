import type { FastifyReply, FastifyRequest } from "fastify";
import type { PublishApiError } from "../shared/publish-v1.js";

export function sendPublishError(
  reply: FastifyReply,
  request: FastifyRequest,
  statusCode: number,
  code: PublishApiError["error"]["code"],
  message: string,
) {
  return reply.code(statusCode).send({ error: { code, message, requestId: request.id } } satisfies PublishApiError);
}
