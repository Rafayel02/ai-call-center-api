import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { PrismaService } from '../prisma/prisma.service';
import { chunkText, decodeVector, encodeVector, knowledgeGuide, searchPassages } from './knowledge';

@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
  ) {}

  async indexScenario(scenarioId: string, sources: { name: string; text: string }[]) {
    const passages = sources.flatMap((source) => chunkText(source.text).map((text) => ({ sourceName: source.name.slice(0, 200) || 'Untitled', text })));
    if (passages.length === 0) throw new BadRequestException('Learning did not find facts in the sources.');
    const vectors = await this.embedAll(passages.map((passage) => `${passage.sourceName}\n${passage.text}`));
    await this.prisma.$transaction(async (tx) => {
      await tx.scenarioKnowledge.deleteMany({ where: { scenarioId } });
      for (let index = 0; index < passages.length; index += 40) {
        await tx.scenarioKnowledge.createMany({
          data: passages.slice(index, index + 40).map((passage, offset) => ({
            scenarioId,
            sourceName: passage.sourceName,
            text: passage.text,
            embedding: encodeVector(vectors[index + offset]),
          })),
        });
      }
    });
    return { passages: passages.length, guide: knowledgeGuide(sources.map((source) => source.name)) };
  }

  async load(scenarioId: string) {
    const rows = await this.prisma.scenarioKnowledge.findMany({ where: { scenarioId }, select: { sourceName: true, text: true, embedding: true } });
    if (rows.length === 0) return null;
    const loaded = rows.map((row) => ({ sourceName: row.sourceName, text: row.text, vector: decodeVector(Buffer.from(row.embedding)) }));
    return {
      search: async (query: string) => {
        const trimmed = query.trim();
        if (!trimmed) return 'No passage matches this question.';
        try {
          const [vector] = await this.llm.embed([trimmed]);
          return searchPassages(decodeVector(encodeVector(vector)), loaded);
        } catch (error) {
          this.logger.warn(`Knowledge lookup failed for scenario ${scenarioId}: ${error instanceof Error ? error.name : 'unknown error'}`);
          throw new Error('Knowledge search is temporarily unavailable.');
        }
      },
    };
  }

  private async embedAll(texts: string[]) {
    const vectors: number[][] = [];
    for (let index = 0; index < texts.length; index += 64) {
      vectors.push(...(await this.llm.embed(texts.slice(index, index + 64))));
    }
    if (vectors.length !== texts.length) throw new BadRequestException('Learning could not store the pages.');
    return vectors;
  }
}
