import { Logger } from '@nestjs/common';
import { ExecutionChannel } from '@prisma/client';
import { IncomingMessage, Server } from 'node:http';
import { Duplex } from 'node:stream';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import { CallSession } from './call-session';
import { OutboundMessage, readInbound } from './call-transport';
import { CallsService } from './calls.service';
import { BROWSER_STREAM_PATH, TWILIO_STREAM_PATH } from './public-url';

export { BROWSER_STREAM_PATH, TWILIO_STREAM_PATH };

const START_WAIT_MS = 10_000;

/**
 * Accepts call WebSockets on the HTTP server. Express middleware does not run on upgrades, so the only ways in are a
 * valid call token in the `start` message, plus Twilio's signature on the handshake for the phone stream. Without
 * them, the socket closes before any audio.
 */
export function attachCallStreams(
  server: Server,
  calls: Pick<CallsService, 'attach'>,
  options: { verifyTwilio: (request: IncomingMessage) => boolean },
) {
  const logger = new Logger('CallStreams');
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '');
    const channel = path === BROWSER_STREAM_PATH ? ExecutionChannel.BROWSER : path === TWILIO_STREAM_PATH ? ExecutionChannel.PHONE : null;
    if (!channel) return refuse(socket, '404 Not Found');
    if (channel === ExecutionChannel.PHONE && !options.verifyTwilio(request)) return refuse(socket, '403 Forbidden');
    sockets.handleUpgrade(request, socket, head, (ws) => serve(ws, channel));
  });

  function refuse(socket: Duplex, status: string) {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  function serve(ws: WebSocket, channel: ExecutionChannel) {
    let session: CallSession | null = null;
    let streamSid: string | undefined;
    const startTimer = setTimeout(() => ws.close(4408, 'No start message.'), START_WAIT_MS);
    const transport = {
      send(message: OutboundMessage) {
        if (ws.readyState !== WebSocket.OPEN) return;
        // Twilio needs the stream id on every message it gets. The browser has no use for it.
        ws.send(JSON.stringify(channel === ExecutionChannel.PHONE ? { ...message, streamSid } : message));
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
      streamSid = message.start.streamSid;
      session = calls.attach(message.start.customParameters?.token, transport, message.start, channel);
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
