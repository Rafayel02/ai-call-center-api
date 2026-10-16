import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const COMMON_VOICE_SOURCE = 'common_voice_20_armenian';

const publicSample = {
  id: true,
  sentence: true,
  age: true,
  gender: true,
  locale: true,
  mimeType: true,
  filename: true,
  byteSize: true,
  source: true,
  externalId: true,
  createdAt: true,
  createdBy: { select: { id: true, email: true } },
} as const;

function blankToNull(value?: string) {
  const trimmed = value?.trim() ?? '';
  if (!trimmed || trimmed.toLowerCase() === 'nan' || trimmed.toLowerCase() === 'none') return null;
  return trimmed;
}

interface AudioUpload {
  buffer?: Buffer;
  size?: number;
  mimetype?: string;
  originalname?: string;
}

@Injectable()
export class DatasetService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const samples = await this.prisma.datasetSample.findMany({
      orderBy: { createdAt: 'desc' },
      select: publicSample,
    });
    return samples;
  }

  async create(
    input: { sentence: string; age?: string; gender?: string; locale?: string; source?: string; externalId?: string },
    file: AudioUpload | undefined,
    userId: string,
  ) {
    const sentence = input.sentence.trim();
    if (!sentence) throw new BadRequestException('Sentence is required.');
    const source = blankToNull(input.source);
    const externalId = blankToNull(input.externalId);
    if (source && source !== COMMON_VOICE_SOURCE) {
      throw new BadRequestException('Unknown dataset source.');
    }
    if (source && !externalId) throw new BadRequestException('Imported samples need an external id.');
    if (!file?.buffer?.length) throw new BadRequestException('Choose an audio file.');
    if ((file.size ?? file.buffer.length) > MAX_AUDIO_BYTES) {
      throw new BadRequestException('Audio file must be 25 MB or smaller.');
    }
    const mimeType = file.mimetype || 'application/octet-stream';
    if (!/^(audio\/|video\/|application\/octet-stream)/.test(mimeType)) {
      throw new BadRequestException('Upload an audio file.');
    }
    const filename = (file.originalname || 'audio').replace(/[^\w.\-]+/g, '_').slice(0, 120);
    let sample;
    try {
      sample = await this.prisma.datasetSample.create({
      data: {
        sentence,
        age: blankToNull(input.age),
        gender: blankToNull(input.gender),
        locale: blankToNull(input.locale),
        source,
        externalId,
        audio: Uint8Array.from(file.buffer),
        mimeType,
        filename,
        byteSize: file.buffer.length,
        createdById: userId,
      },
      select: publicSample,
    });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('This sample is already imported.');
      }
      throw error;
    }
    return sample;
  }

  async audio(id: string) {
    const sample = await this.prisma.datasetSample.findUnique({
      where: { id },
      select: { audio: true, mimeType: true, filename: true },
    });
    if (!sample) throw new NotFoundException('Dataset sample not found.');
    return sample;
  }

  async remove(id: string) {
    try {
      await this.prisma.datasetSample.delete({ where: { id } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException('Dataset sample not found.');
      }
      throw error;
    }
    return { ok: true };
  }
}
