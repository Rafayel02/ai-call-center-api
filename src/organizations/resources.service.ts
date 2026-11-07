import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, ResourceStatus } from '@prisma/client';
import { LlmService } from '../llm/llm.service';
import { PrismaService } from '../prisma/prisma.service';
import { focusSearchQuery } from '../common/search-query';
import { isSocialTurn, spokenFromPassages } from '../telephony/scenario-voice';
import { pageIdentity } from '../scenarios/site-pages';
import { publicUrl } from '../scenarios/voice-sources';
import { decodeResource, resourceFileName, type IndexState } from './organization-resources';
import { crawlWebsite } from './site-crawl';
import { withFrontMatter } from './site-export';
import { fetchPublicPage } from './site-fetch';
import {
  attachOpenAiFile,
  createOpenAiVectorStore,
  deleteOpenAiFile,
  deleteOpenAiVectorStore,
  formatSearchHits,
  OpenAiRequestError,
  readOpenAiFile,
  inspectOpenAiVectorStore,
  searchOpenAiVectorStore,
  uploadOpenAiFile,
} from './openai-vector-store';

const publicResource = {
  id: true,
  name: true,
  byteSize: true,
  sourceUrl: true,
  status: true,
  errorMessage: true,
  createdAt: true,
} satisfies Prisma.OrganizationResourceSelect;

export type SiteImportEvent =
  | { type: 'exported'; resource: Prisma.OrganizationResourceGetPayload<{ select: typeof publicResource }> }
  | { type: 'done'; discovered: number; exported: number; skipped: number; failed: number };

@Injectable()
export class ResourcesService {
  private readonly logger = new Logger(ResourcesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
  ) {}

  async passages(organizationId: string, resourceIds: string[], query: string) {
    const trimmed = focusSearchQuery(query).slice(0, 1000);
    if (!trimmed || resourceIds.length === 0) return 'No passage matches this question.';
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { openaiVectorStoreId: true },
    });
    if (!organization?.openaiVectorStoreId) return 'No passage matches this question.';
    const files = await this.prisma.organizationResource.findMany({
      where: { organizationId, id: { in: resourceIds }, status: ResourceStatus.READY },
      select: { openaiFileId: true },
    });
    if (files.length === 0) return 'No passage matches this question.';
    try {
      const hits = await searchOpenAiVectorStore(
        await this.key(),
        organization.openaiVectorStoreId,
        trimmed,
        files.map((file) => file.openaiFileId),
      );
      return formatSearchHits(hits) || 'No passage matches this question.';
    } catch (error) {
      this.logger.warn(`Resource search failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      throw error;
    }
  }

  /** Search every ready file in the organization and return the passages OpenAI ranked. */
  async search(organizationId: string, query: string) {
    const trimmed = query.trim().slice(0, 1000);
    if (!trimmed) throw new BadRequestException('Write an inquiry.');
    const searchQuery = focusSearchQuery(trimmed);
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, openaiVectorStoreId: true },
    });
    if (!organization) throw new NotFoundException('Organization not found.');
    if (!organization.openaiVectorStoreId) return { query: trimmed, searchQuery, queries: [] as string[], hits: [] };
    const files = await this.prisma.organizationResource.findMany({
      where: { organizationId, status: ResourceStatus.READY },
      select: { name: true, sourceUrl: true, openaiFileId: true },
    });
    if (files.length === 0) return { query: trimmed, searchQuery, queries: [] as string[], hits: [] };
    const found = await inspectOpenAiVectorStore(
      await this.key(),
      organization.openaiVectorStoreId,
      searchQuery,
      files.map((file) => file.openaiFileId),
    );
    const named = new Map(files.map((file) => [file.openaiFileId, file]));
    return {
      query: trimmed,
      searchQuery,
      queries: found.queries,
      hits: found.hits.map((hit) => {
        const file = named.get(hit.fileId);
        return {
          name: file?.name || hit.filename,
          sourceUrl: file?.sourceUrl ?? null,
          score: hit.score,
          text: hit.text,
        };
      }),
    };
  }

  /** A spoken sentence from the selected files, plus the passages that were searched. Social turns do not search. */
  async spokenAnswer(organizationId: string, resourceIds: string[], query: string, llmModelId: string, languageName: string) {
    const trimmed = query.trim();
    const searchQuery = focusSearchQuery(trimmed);
    if (!trimmed || !llmModelId || resourceIds.length === 0 || isSocialTurn(trimmed)) return { reply: null, passages: '', searchQuery };
    const passages = await this.passages(organizationId, resourceIds, searchQuery);
    const instructions = 'Start with the answer from the connected files. A different spelling of the same product is the same subject. Speak the concrete details the passages contain, such as what the package includes, the price, or the conditions. Do not say you cannot help. Say the information is missing only when every passage is unrelated, and then that is the whole reply.';
    try {
      const reply = (await this.llm.voiceReply(llmModelId, languageName, trimmed, instructions, passages)).trim();
      return { reply: reply || null, passages, searchQuery };
    } catch {
      if (!passages || passages === 'No passage matches this question.') return { reply: null, passages, searchQuery };
      return { reply: spokenFromPassages(passages), passages, searchQuery };
    }
  }

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
    const saved = await this.persist(organization, apiKey, name, bytes, null, createdById, 8);
    if (!saved) throw new BadRequestException('OpenAI could not index the file.');
    return saved;
  }

  async assertCanImport(organizationId: string, url: string) {
    await publicUrl(url.trim());
    const organization = await this.organization(organizationId);
    await this.ensureStore(organization, await this.key());
  }

  async importSite(organizationId: string, url: string, createdById: string, emit: (event: SiteImportEvent) => void) {
    const start = await publicUrl(url.trim());
    const organization = await this.organization(organizationId);
    const apiKey = await this.key();
    const rows = await this.prisma.organizationResource.findMany({
      where: { organizationId, sourceUrl: { not: null } },
      select: { sourceUrl: true },
    });
    const known = new Set(rows.map((row) => row.sourceUrl).filter((value): value is string => Boolean(value)));
    const report = await crawlWebsite(start.toString(), {
      known,
      fetchPage: (page) => fetchPublicPage(page),
      onPage: async (page) => {
        const document = withFrontMatter({
          title: page.title,
          source: page.url,
          finalUrl: page.finalUrl,
          markdown: page.markdown,
          fetchedAt: new Date().toISOString(),
        });
        const bytes = Buffer.from(document.text, 'utf8');
        if (bytes.length > 1_000_000) throw new Error('This page is larger than 1 MB.');
        const saved = await this.persist(organization, apiKey, resourceFileName(page.fileName), bytes, pageIdentity(page.url) ?? page.url, createdById, 1);
        if (!saved) return 'duplicate';
        emit({ type: 'exported', resource: saved });
        return 'saved';
      },
    });
    emit({
      type: 'done',
      discovered: report.discovered,
      exported: report.exported.length,
      skipped: report.skipped.length,
      failed: report.failed.length,
    });
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

  private async organization(id: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { id },
      select: { id: true, name: true, openaiVectorStoreId: true },
    });
    if (!organization) throw new NotFoundException('Organization not found.');
    return organization;
  }

  private async persist(
    organization: { id: string; name: string; openaiVectorStoreId: string | null },
    apiKey: string,
    name: string,
    bytes: Buffer,
    sourceUrl: string | null,
    createdById: string,
    attempts: number,
  ) {
    let storeId = organization.openaiVectorStoreId;
    let fileId: string | null = null;
    try {
      storeId = await this.ensureStore(organization, apiKey);
      organization.openaiVectorStoreId = storeId;
      fileId = await uploadOpenAiFile(apiKey, name, bytes);
      await attachOpenAiFile(apiKey, storeId, fileId);
      const indexed = await this.waitForIndex(apiKey, storeId, fileId, attempts);
      return await this.prisma.organizationResource.create({
        data: {
          organizationId: organization.id,
          name,
          byteSize: bytes.length,
          openaiFileId: fileId,
          sourceUrl,
          status: indexed.status,
          errorMessage: indexed.errorMessage,
          createdById,
        },
        select: publicResource,
      });
    } catch (error) {
      if (fileId && storeId) await deleteOpenAiFile(apiKey, storeId, fileId).catch(() => undefined);
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null;
      if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
      throw new BadRequestException(this.openAiMessage(error));
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

  private async waitForIndex(apiKey: string, vectorStoreId: string, fileId: string, attempts: number): Promise<IndexState> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const indexed = await readOpenAiFile(apiKey, vectorStoreId, fileId);
      if (indexed.status !== 'INDEXING') return indexed;
      if (attempt === attempts - 1) return { status: 'INDEXING', errorMessage: null };
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
