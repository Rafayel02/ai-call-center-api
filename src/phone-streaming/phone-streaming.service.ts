import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PhoneStreamProvider, Prisma } from '@prisma/client';
import { z } from 'zod';
import { decryptSecret, encryptSecret, encryptionKeyFromEnv, EncryptedSecret, secretHint } from '../common/crypto/credential-cipher';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePhoneStreamingDto, TestPhoneStreamingDto, UpdatePhoneStreamingDto } from './dto/phone-streaming.dto';

const accountSid = z.string().trim().regex(/^AC[0-9a-fA-F]{32}$/, 'Account SID starts with AC and is on the Twilio account page.');
const authToken = z.string().trim().min(16).max(200);
const createConfig = z.object({ accountSid, authToken });
const updateConfig = z.object({ accountSid: accountSid.optional(), authToken: authToken.optional() });

interface StoredConfig {
  accountSid: string;
  authTokenHint: string;
  authToken: EncryptedSecret;
}

const listSelect = {
  id: true,
  name: true,
  provider: true,
  config: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PhoneStreamingServiceSelect;

/** Twilio accounts an admin connects. The auth token stays encrypted. */
@Injectable()
export class PhoneStreamingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async list() {
    const rows = await this.prisma.phoneStreamingService.findMany({ select: listSelect, orderBy: { createdAt: 'desc' } });
    return rows.map((row) => this.present(row));
  }

  async create(dto: CreatePhoneStreamingDto, userId: string) {
    const row = await this.prisma.phoneStreamingService.create({
      data: {
        name: dto.name.trim(),
        provider: PhoneStreamProvider.TWILIO,
        config: this.storeCreate(dto.config) as unknown as Prisma.InputJsonValue,
        enabled: dto.enabled ?? true,
        createdById: userId,
      },
      select: listSelect,
    });
    return this.present(row);
  }

  async update(id: string, dto: UpdatePhoneStreamingDto) {
    const current = await this.findOrThrow(id);
    const stored = dto.config ? this.storeUpdate(dto.config, this.readStored(current.config)) : this.readStored(current.config);
    const row = await this.prisma.phoneStreamingService.update({
      where: { id },
      data: {
        ...(dto.name ? { name: dto.name.trim() } : {}),
        ...(dto.enabled === undefined ? {} : { enabled: dto.enabled }),
        config: stored as unknown as Prisma.InputJsonValue,
      },
      select: listSelect,
    });
    return this.present(row);
  }

  async remove(id: string) {
    await this.findOrThrow(id);
    const numbers = await this.prisma.phoneNumber.count({ where: { streamingServiceId: id } });
    if (numbers > 0) throw new BadRequestException('Remove the phone numbers on this service before deleting it.');
    await this.prisma.phoneStreamingService.delete({ where: { id } });
    return { ok: true };
  }

  async testDraft(dto: TestPhoneStreamingDto) {
    const parsed = createConfig.safeParse(dto.config);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Enter the Twilio account SID and auth token.');
    return this.probe(parsed.data.accountSid, parsed.data.authToken);
  }

  async testStored(id: string) {
    const row = await this.findOrThrow(id);
    const stored = this.readStored(row.config);
    return this.probe(stored.accountSid, decryptSecret(stored.authToken, this.key()));
  }

  /** Auth tokens of enabled Twilio accounts. A webhook is accepted when any of them signed it. */
  async authTokens() {
    return (await this.credentials()).map((account) => account.authToken);
  }

  async credentials() {
    const rows = await this.prisma.phoneStreamingService.findMany({
      where: { provider: PhoneStreamProvider.TWILIO, enabled: true },
      select: { config: true },
    });
    return rows.map((row) => {
      const stored = this.readStored(row.config);
      return { accountSid: stored.accountSid, authToken: decryptSecret(stored.authToken, this.key()) };
    });
  }

  private async probe(sid: string, token: string) {
    let response: Response;
    try {
      response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`, {
        headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` },
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      return { ok: false, message: 'Could not reach Twilio.' };
    }
    if (response.status === 401 || response.status === 403) return { ok: false, message: 'Twilio rejected this account SID or auth token.' };
    if (!response.ok) return { ok: false, message: `Twilio returned status ${response.status}.` };
    return { ok: true, message: 'Twilio accepted this account.' };
  }

  private present(row: { id: string; name: string; provider: PhoneStreamProvider; config: Prisma.JsonValue; enabled: boolean; createdAt: Date; updatedAt: Date }) {
    const stored = this.readStored(row.config);
    return {
      id: row.id,
      name: row.name,
      provider: row.provider,
      enabled: row.enabled,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      config: { accountSid: stored.accountSid, authTokenHint: stored.authTokenHint },
    };
  }

  private storeCreate(config: unknown): StoredConfig {
    const parsed = createConfig.safeParse(config);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Enter the Twilio account SID and auth token.');
    return this.seal(parsed.data.accountSid, parsed.data.authToken);
  }

  private storeUpdate(config: unknown, current: StoredConfig): StoredConfig {
    const parsed = updateConfig.safeParse(config ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Enter the Twilio account SID and auth token.');
    return this.seal(parsed.data.accountSid ?? current.accountSid, parsed.data.authToken ?? decryptSecret(current.authToken, this.key()));
  }

  private seal(sid: string, token: string): StoredConfig {
    return { accountSid: sid, authTokenHint: secretHint(token), authToken: encryptSecret(token, this.key()) };
  }

  private readStored(config: unknown): StoredConfig {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new BadRequestException('Stored Twilio account is incomplete.');
    const record = config as Partial<StoredConfig>;
    if (!record.accountSid || !record.authTokenHint || !record.authToken) throw new BadRequestException('Stored Twilio account is incomplete.');
    return { accountSid: record.accountSid, authTokenHint: record.authTokenHint, authToken: record.authToken };
  }

  private async findOrThrow(id: string) {
    const row = await this.prisma.phoneStreamingService.findUnique({ where: { id }, select: listSelect });
    if (!row) throw new NotFoundException('Phone streaming service not found.');
    return row;
  }

  private key() {
    return encryptionKeyFromEnv(this.config.getOrThrow<string>('CREDENTIAL_ENCRYPTION_KEY'));
  }
}
