import { Logger } from '@nestjs/common';
import { IncomingMessage, Server } from 'node:http';
import { Duplex } from 'node:stream';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import { CallSession } from './call-session';
import { readInbound } from './call-transport';
import { CallsService } from './calls.service';

const START_WAIT_MS = 10_000;
export const BROWSER_STREAM_PATH = '/calls/browser/stream';

/**
 * Accepts call WebSockets on the HTTP server. Express middleware does not run on upgrades, so the only way in is a
 * valid call token in the `start` message. Without one, the socket closes before any audio.
 */
export function attachCallStreams(server: Server, calls: Pick<CallsService, 'attach'>) {
  const logger = new Logger('CallStreams');
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path !== BROWSER_STREAM_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => serve(ws));
  });

  function serve(ws: WebSocket) {
    let session: CallSession | null = null;
    const startTimer = setTimeout(() => ws.close(4408, 'No start message.'), START_WAIT_MS);
    const transport = {
      send(message: object) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      },
      close() {
        if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'Call ended.');
      },
    };

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      const message = readInbound(rawText(data));
      if (!message) return;
      if (session) {
        session.receive(message);
        return;
      }
      if (message.event !== 'start') return;
      clearTimeout(startTimer);
      session = calls.attach(message.start.customParameters?.token, transport, message.start);
      if (!session) ws.close(4401, 'The call token is not valid.');
    });
    ws.on('close', () => {
      clearTimeout(startTimer);
      session?.hangUp();
    });
    ws.on('error', (error) => logger.warn(`Call stream error: ${error.message}`));
  }

  return sockets;
}

function rawText(data: RawData) {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
