import { BadRequestException } from '@nestjs/common';
import { IncomingHttpHeaders } from 'node:http';

type HeaderBag = IncomingHttpHeaders | Record<string, string | string[] | undefined>;

function first(headers: HeaderBag, name: string) {
  const value = headers[name];
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(',')[0]?.trim() ?? '';
}

/** The origin this request already arrived on. On Railway that is the existing public API host. */
export function publicOrigin(headers: HeaderBag) {
  const host = first(headers, 'x-forwarded-host') || first(headers, 'host');
  if (!host) throw new BadRequestException('The request has no host.');
  const forwarded = first(headers, 'x-forwarded-proto');
  const proto = forwarded || (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : 'https');
  return `${proto}://${host}`.replace(/\/+$/, '');
}
