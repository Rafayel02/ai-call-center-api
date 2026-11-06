import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, ResourceStatus } from '@prisma/client';
import { LlmService } from '../llm/llm.service';
import { PrismaService } from '../prisma/prisma.service';
import { decodeResource, resourceFileName, type IndexState } from './organization-resources';
import {
  attachOpenAiFile,
  createOpenAiVectorStore,
  deleteOpenAiFile,
  deleteOpenAiVectorStore,
  OpenAiRequestError,
  readOpenAiFile,
  uploadOpenAiFile,
} from './openai-vector-store';

const publicResource = {
  id: true,
  name: true,
  byteSize: true,
  status: true,
  errorMessage: true,
  createdAt: true,
} satisfies Prisma.OrganizationResourceSelect;

@Injectable()
export class ResourcesService {
  private readonly logger = new Logger(ResourcesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
  ) {}

  async list(organizationId: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, openaiVectorStoreId: true },
    });
    if (!organization) throw new NotFoundException('Organization not found.');
    await this.refresh(organizationId, organization.openaiVectorStoreId);
    return this.prisma.organizationResource.findMany({
      where: { organizationId },
      select: publicResource,
      orderBy: { createdAt: 'desc' },
    });
  }

  async add(organizationId: string, input: { name: string; data: string }, createdById: string) {
    const name = resourceFileName(input.name);
    const bytes = decodeResource(input.data);
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, name: true, openaiVectorStoreId: true },
    });
    if (!organization) throw new NotFoundException('Organization not found.');
    const apiKey = await this.key();
    let storeId = organization.openaiVectorStoreId;
    let fileId: string | null = null;
    try {
      storeId = await this.ensureStore(organization, apiKey);
      fileId = await uploadOpenAiFile(apiKey, name, bytes);
      await attachOpenAiFile(apiKey, storeId, fileId);
      const indexed = await this.waitForIndex(apiKey, storeId, fileId);
      return await this.prisma.organizationResource.create({
        data: {
          organizationId,
          name,
          byteSize: bytes.length,
          openaiFileId: fileId,
          status: indexed.status,
          errorMessage: indexed.errorMessage,
          createdById,
        },
        select: publicResource,
      });
    } catch (error) {
      if (fileId && storeId) await deleteOpenAiFile(apiKey, storeId, fileId).catch(() => undefined);
      if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
      throw new BadRequestException(this.openAiMessage(error));
    }
  }

  async remove(organizationId: string, resourceId: string) {
    const resource = await this.prisma.organizationResource.findFirst({
      where: { id: resourceId, organizationId },
      select: { id: true, openaiFileId: true, organization: { select: { openaiVectorStoreId: true } } },
    });
    if (!resource) throw new NotFoundException('Resource not found.');
    if (resource.organization.openaiVectorStoreId) {
      try {
        await deleteOpenAiFile(await this.key(), resource.organization.openaiVectorStoreId, resource.openaiFileId);
      } catch (error) {
        throw new BadRequestException(this.openAiMessage(error));
      }
    }
    await this.prisma.organizationResource.delete({ where: { id: resource.id } });
    return { ok: true };
  }

  async discardOrganization(organizationId: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { openaiVectorStoreId: true, resources: { select: { openaiFileId: true } } },
    });
    if (!organization || (!organization.openaiVectorStoreId && organization.resources.length === 0)) return;
    const apiKey = await this.llm.realtimeKey('OPENAI');
    if (!apiKey) throw new BadRequestException('Add an enabled OpenAI model before deleting indexed files.');
    try {
      if (organization.openaiVectorStoreId) {
        for (const resource of organization.resources) {
          await deleteOpenAiFile(apiKey, organization.openaiVectorStoreId, resource.openaiFileId);
        }
        await deleteOpenAiVectorStore(apiKey, organization.openaiVectorStoreId);
      }
    } catch (error) {
      throw new BadRequestException(this.openAiMessage(error));
    }
  }

  private async refresh(organizationId: string, vectorStoreId: string | null) {
    if (!vectorStoreId) return;
    const pending = await this.prisma.organizationResource.findMany({
      where: { organizationId, status: ResourceStatus.INDEXING },
      select: { id: true, openaiFileId: true },
    });
    if (pending.length === 0) return;
    const apiKey = await this.llm.realtimeKey('OPENAI');
    if (!apiKey) return;
    for (const resource of pending) {
      try {
        const indexed = await readOpenAiFile(apiKey, vectorStoreId, resource.openaiFileId);
        if (indexed.status === 'INDEXING') continue;
        await this.prisma.organizationResource.update({
          where: { id: resource.id },
          data: { status: indexed.status, errorMessage: indexed.errorMessage },
        });
      } catch (error) {
        if (error instanceof OpenAiRequestError && error.status === 404) {
          await this.prisma.organizationResource.update({
            where: { id: resource.id },
            data: { status: ResourceStatus.FAILED, errorMessage: 'This file is no longer in the OpenAI index.' },
          });
          continue;
        }
        this.logger.warn(`Could not refresh a resource: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
  }

  private async ensureStore(organization: { id: string; name: string; openaiVectorStoreId: string | null }, apiKey: string) {
    if (organization.openaiVectorStoreId) return organization.openaiVectorStoreId;
    const created = await createOpenAiVectorStore(apiKey, organization.name);
    const saved = await this.prisma.organization.updateMany({
      where: { id: organization.id, openaiVectorStoreId: null },
      data: { openaiVectorStoreId: created },
    });
    if (saved.count === 1) return created;
    await deleteOpenAiVectorStore(apiKey, created).catch(() => undefined);
    const current = await this.prisma.organization.findUnique({
      where: { id: organization.id },
      select: { openaiVectorStoreId: true },
    });
    if (!current?.openaiVectorStoreId) throw new BadRequestException('Could not prepare the file index.');
    return current.openaiVectorStoreId;
  }

  private async waitForIndex(apiKey: string, vectorStoreId: string, fileId: string): Promise<IndexState> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const indexed = await readOpenAiFile(apiKey, vectorStoreId, fileId);
      if (indexed.status !== 'INDEXING') return indexed;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    return { status: 'INDEXING', errorMessage: null };
  }

  private async key() {
    const apiKey = await this.llm.realtimeKey('OPENAI');
    if (!apiKey) throw new BadRequestException('Add an enabled OpenAI model before uploading a file.');
    return apiKey;
  }

  private openAiMessage(error: unknown) {
    if (error instanceof OpenAiRequestError && error.status === 401) return 'The OpenAI key was rejected. Check the enabled OpenAI model.';
    if (error instanceof OpenAiRequestError && error.message.trim()) return error.message;
    return 'OpenAI could not index the file.';
  }
}
