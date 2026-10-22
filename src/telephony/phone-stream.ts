import { Server as HttpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { TelephonyService } from './telephony.service';

/** Twilio opens this socket from the Stream verb. The voice webhook is a normal POST. */
export function attachPhoneStream(server: HttpServer, telephony: TelephonyService) {
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    const path = (request.url ?? '').split('?')[0];
    if (path === '/telephony/talk') {
      sockets.handleUpgrade(request, socket, head, (ws) => {
        telephony.openTalk(ws, request);
      });
      return;
    }
    if (path !== '/telephony/twilio/stream') {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      void telephony.openStream(ws, request);
    });
  });
}
