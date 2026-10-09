/**
 * What a running HTTP service offers to the code that assembles and operates it. The web
 * framework behind it stays an implementation detail of the package that builds the service.
 */
export interface HttpRuntime {
  /** Answers one request in process, without a listening socket. */
  fetch(request: Request): Promise<Response>;
  /** Starts listening and resolves with the base URL the service is reachable at. */
  listen(input?: HttpListenInput): Promise<string>;
  close(): Promise<void>;
}

export interface HttpListenInput {
  host?: string;
  port?: number;
}
