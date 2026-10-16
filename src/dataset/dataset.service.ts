import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

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
      select: {
        id: true,
        name: true,
        transcript: true,
        mimeType: true,
        filename: true,
        byteSize: true,
        createdAt: true,
        createdBy: { select: { id: true, email: true } },
      },
    });
    return samples;
  }

  async create(input: { name: string; transcript: string }, file: AudioUpload | undefined, userId: string) {
    const name = input.name.trim();
    const transcript = input.transcript.trim();
    if (!name) throw new BadRequestException('Name is required.');
    if (!transcript) throw new BadRequestException('Exact text is required.');
    if (!file?.buffer?.length) throw new BadRequestException('Choose an audio file.');
    if ((file.size ?? file.buffer.length) > MAX_AUDIO_BYTES) {
      throw new BadRequestException('Audio file must be 25 MB or smaller.');
    }
    const mimeType = file.mimetype || 'application/octet-stream';
    if (!/^(audio\/|video\/|application\/octet-stream)/.test(mimeType)) {
      throw new BadRequestException('Upload an audio file.');
    }
    const filename = (file.originalname || 'audio').replace(/[^\w.\-]+/g, '_').slice(0, 120);
    const sample = await this.prisma.datasetSample.create({
      data: {
        name,
        transcript,
        audio: Uint8Array.from(file.buffer),
        mimeType,
        filename,
        byteSize: file.buffer.length,
        createdById: userId,
      },
      select: {
        id: true,
        name: true,
        transcript: true,
        mimeType: true,
        filename: true,
        byteSize: true,
        createdAt: true,
        createdBy: { select: { id: true, email: true } },
      },
    });
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
