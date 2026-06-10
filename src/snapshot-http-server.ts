import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { SnapshotCache, SnapshotCacheError, type SnapshotProfile } from "./snapshot-cache.js";

export interface SnapshotHttpServerOptions {
  profile?: SnapshotProfile;
}

export function createSnapshotHttpServer(
  cache: SnapshotCache,
  options: SnapshotHttpServerOptions = {},
): Server {
  const profile = options.profile ?? "sub";

  return createServer((request, response) => {
    handleSnapshotRequest(cache, profile, request, response);
  });
}

function handleSnapshotRequest(
  cache: SnapshotCache,
  profile: SnapshotProfile,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const match = matchSnapshotPath(request.url);

  if (!match) {
    writeText(response, 404, "Not found.\n");
    return;
  }

  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    writeText(response, 405, "Method not allowed.\n");
    return;
  }

  let cameraName: string;

  try {
    cameraName = decodeURIComponent(match.cameraName);
  } catch {
    writeText(response, 400, "Invalid camera name.\n");
    return;
  }

  let snapshot;

  try {
    snapshot = cache.get(cameraName, profile);
  } catch (error) {
    if (error instanceof SnapshotCacheError) {
      writeText(response, 404, "Snapshot not found.\n");
      return;
    }

    throw error;
  }

  if (!snapshot) {
    writeText(response, 404, "Snapshot not found.\n");
    return;
  }

  response.statusCode = 200;
  response.setHeader("Content-Type", "image/jpeg");
  response.setHeader("Content-Length", snapshot.buffer.length);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Argus-Captured-At", snapshot.capturedAt.toISOString());
  response.end(snapshot.buffer);
}

function matchSnapshotPath(requestUrl: string | undefined): { cameraName: string } | undefined {
  if (!requestUrl) {
    return undefined;
  }

  let url: URL;

  try {
    url = new URL(requestUrl, "http://127.0.0.1");
  } catch {
    return undefined;
  }

  const segments = url.pathname.split("/");

  if (segments.length !== 4 || segments[0] !== "" || segments[1] !== "cameras" || segments[3] !== "snapshot.jpg") {
    return undefined;
  }

  const cameraName = segments[2];

  if (!cameraName) {
    return undefined;
  }

  return { cameraName };
}

function writeText(response: ServerResponse, statusCode: number, body: string): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}
