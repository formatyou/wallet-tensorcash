export class GatewayError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 503) { super(message); }
}
export class RpcError extends Error {
  constructor(public readonly code: number, message: string) { super(message); }
}
export function ensure(condition: unknown, message = 'Invalid chain provider response'): asserts condition {
  if (!condition) throw new GatewayError('invalid-provider-data', message);
}
