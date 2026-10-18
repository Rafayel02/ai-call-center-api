/**
 * Runs against the test database: npm run test:db
 *
 * ElevenLabs and HiSpeech are replaced by a fake provider that records every call that would be paid.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';
import { BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderRegistry } from '../speech-to-text/providers/provider.registry';
import { SpeechToTextComparisonService } from './speech-to-text-comparison.service';

Logger.overrideLogger(false);
const prisma = new PrismaService();

function fakeProvider() {
  const paid: string[] = [];
  let failure: string | null = null;
  let gate: Promise<void> | null = null;
  return {
    paid,
    failWith(message: string | null) {
      failure = message;
    },
    /** Holds every call until the returned function is called. */
    hold() {
      let release = () => {};
      gate = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        gate = null;
        release();
      };
    },
    provider: {
      id: 'ELEVENLABS',
      engineKey: (config: Record<string, unknown>) => `FAKE|${String(config.modelId)}`,
      async transcribe(config: Record<string, unknown>, audio: { filename: string }) {
        paid.push(`FAKE|${String(config.modelId)} ${audio.filename}`);
        if (gate) await gate;
        if (failure) throw new BadRequestException(failure);
        return { text: 'Բարև ձեզ', languageCode: 'hye' };
      },
    },
  };
}

function comparison(fake = fakeProvider()) {
  const registry = new ProviderRegistry(fake.provider as never, fake.provider as never);
  return { fake, service: new SpeechToTextComparisonService(prisma, registry) };
}

let ownerId = '';
let sampleNumber = 0;

async function addModel(name: string, modelId: string, enabled = true) {
  const model = await prisma.speechToTextModel.create({
    data: { name, provider: 'ELEVENLABS', enabled, config: { modelId }, createdById: ownerId },
  });
  return model.id;
}

/** Samples are created oldest first, each with its own recording. */
async function addSamples(count: number) {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    sampleNumber++;
    const audio = Buffer.from(`recording ${sampleNumber}`);
    const sample = await prisma.datasetSample.create({
      data: {
        sentence: 'Բարև ձեզ',
        audio: Uint8Array.from(audio),
        audioSha256: createHash('sha256').update(audio).digest('hex'),
        mimeType: 'audio/mpeg',
        filename: `s${sampleNumber}.mp3`,
        byteSize: audio.length,
        createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, sampleNumber)),
        createdById: ownerId,
      },
    });
    ids.push(sample.id);
  }
  return ids;
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "users" CASCADE');
  const owner = await prisma.user.create({ data: { email: 'owner@example.com', passwordHash: 'x' } });
  ownerId = owner.id;
});

after(async () => {
  await prisma.$disconnect();
});

test('a check that succeeded is reused and not paid again', async () => {
  const { fake, service } = comparison();
  const modelId = await addModel('Scribe', 'm1');
  const [sampleId] = await addSamples(1);

  await service.check({ modelId, sampleId });
  const again = await service.check({ modelId, sampleId });

  assert.equal(again.reused, true);
  assert.equal(fake.paid.length, 1);
});

test('two requests for the same check at the same time pay once', async () => {
  const { fake, service } = comparison();
  const modelId = await addModel('Scribe', 'm1');
  const [sampleId] = await addSamples(1);

  const release = fake.hold();
  const both = Promise.all([service.check({ modelId, sampleId }), service.check({ modelId, sampleId })]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  const [first, second] = await both;

  assert.equal(fake.paid.length, 1);
  assert.equal(first.transcript, 'Բարև ձեզ');
  assert.equal(second.transcript, 'Բարև ձեզ');
});

test('two requests at the same time for a check that fails pay once', async () => {
  const { fake, service } = comparison();
  const modelId = await addModel('Scribe', 'm1');
  const [sampleId] = await addSamples(1);
  fake.failWith('HiSpeech returned status 503.');

  const release = fake.hold();
  const both = Promise.allSettled([service.check({ modelId, sampleId }), service.check({ modelId, sampleId })]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  const outcomes = await both;

  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ['rejected', 'rejected'],
  );
  assert.equal(fake.paid.length, 1);
});

test('a disabled model is rejected without paying or storing anything', async () => {
  const { fake, service } = comparison();
  const modelId = await addModel('Scribe', 'm1', false);
  const [sampleId] = await addSamples(1);

  await assert.rejects(service.check({ modelId, sampleId }), /disabled/);
  const preview = await service.preview({ modelIds: [modelId], sampleIds: [sampleId] });

  assert.equal(fake.paid.length, 0);
  assert.deepEqual(preview.results, []);
});

test('another saved model with the same settings reuses the check', async () => {
  const { fake, service } = comparison();
  const original = await addModel('Scribe', 'm1');
  const copy = await addModel('Scribe again', 'm1');
  const [sampleId] = await addSamples(1);

  await service.check({ modelId: original, sampleId });
  const shared = await service.check({ modelId: copy, sampleId });

  assert.equal(shared.reused, true);
  assert.equal(fake.paid.length, 1);
});

test('a preview never calls the provider', async () => {
  const { fake, service } = comparison();
  const scribe = await addModel('Scribe', 'm1');
  const hispeech = await addModel('HiSpeech', 'm2');
  const sampleIds = await addSamples(5);
  await service.check({ modelId: scribe, sampleId: sampleIds[0] });
  const paidBefore = fake.paid.length;

  await service.preview({ modelIds: [scribe, hispeech], count: 5 });
  await service.preview({ modelIds: [scribe, hispeech], sampleIds });

  assert.equal(fake.paid.length, paidBefore);
});

test('a failed check is stored with its reason', async () => {
  const { fake, service } = comparison();
  const modelId = await addModel('Scribe', 'm1');
  const [sampleId] = await addSamples(1);
  fake.failWith('ElevenLabs rejected this API key.');

  await assert.rejects(service.check({ modelId, sampleId }), /rejected this API key/);
  const preview = await service.preview({ modelIds: [modelId], sampleIds: [sampleId] });

  assert.deepEqual(
    preview.results.map((result) => ({ status: result.status, error: result.error })),
    [{ status: 'FAILED', error: 'ElevenLabs rejected this API key.' }],
  );
});

test('a retry that succeeds replaces the stored failure', async () => {
  const { fake, service } = comparison();
  const modelId = await addModel('Scribe', 'm1');
  const [sampleId] = await addSamples(1);
  fake.failWith('HiSpeech returned status 503.');
  await assert.rejects(service.check({ modelId, sampleId }));

  fake.failWith(null);
  const retried = await service.check({ modelId, sampleId });
  const preview = await service.preview({ modelIds: [modelId], sampleIds: [sampleId] });

  assert.equal(retried.transcript, 'Բարև ձեզ');
  assert.deepEqual(
    preview.results.map((result) => ({ status: result.status, transcript: result.transcript })),
    [{ status: 'SUCCEEDED', transcript: 'Բարև ձեզ' }],
  );
});

test('a failure that finishes after a success never replaces it', async () => {
  // Two API instances checking the same pair at once: one succeeds, the other fails later.
  const first = comparison();
  const second = comparison();
  const modelId = await addModel('Scribe', 'm1');
  const [sampleId] = await addSamples(1);
  second.fake.failWith('Could not reach ElevenLabs.');

  const releaseFirst = first.fake.hold();
  const releaseSecond = second.fake.hold();
  const succeeded = first.service.check({ modelId, sampleId });
  const failed = second.service.check({ modelId, sampleId });
  await new Promise((resolve) => setTimeout(resolve, 50));
  releaseFirst();
  await succeeded;
  releaseSecond();
  await assert.rejects(failed);
  const preview = await first.service.preview({ modelIds: [modelId], sampleIds: [sampleId] });

  assert.deepEqual(
    preview.results.map((result) => result.status),
    ['SUCCEEDED'],
  );
});

test('a stored failure is a retry in the next preview', async () => {
  const { fake, service } = comparison();
  const modelId = await addModel('Scribe', 'm1');
  const [failedSample, newSample, checkedSample] = await addSamples(3);
  await service.check({ modelId, sampleId: checkedSample });
  fake.failWith('HiSpeech returned status 503.');
  await assert.rejects(service.check({ modelId, sampleId: failedSample }));

  const preview = await service.preview({ modelIds: [modelId], sampleIds: [failedSample, newSample, checkedSample] });

  assert.deepEqual(preview.checks, [
    { modelId, sampleId: failedSample, retry: true },
    { modelId, sampleId: newSample, retry: false },
  ]);
  assert.equal(preview.newChecks, 2);
  assert.equal(preview.retries, 1);
});

test('in automatic mode each engine gets its own next samples, stored failures first', async () => {
  const { fake, service } = comparison();
  const scribe = await addModel('Scribe', 'm1');
  const hispeech = await addModel('HiSpeech', 'm2');
  const [s1, s2, s3, s4] = await addSamples(5);
  await service.check({ modelId: scribe, sampleId: s1 });
  await service.check({ modelId: scribe, sampleId: s2 });
  fake.failWith('HiSpeech returned status 503.');
  await assert.rejects(service.check({ modelId: scribe, sampleId: s4 }));
  fake.failWith(null);

  const preview = await service.preview({ modelIds: [scribe, hispeech], count: 2 });

  assert.deepEqual(preview.checks, [
    { modelId: hispeech, sampleId: s1, retry: false },
    { modelId: hispeech, sampleId: s2, retry: false },
    { modelId: scribe, sampleId: s3, retry: false },
    { modelId: scribe, sampleId: s4, retry: true },
  ]);
});

test('models with the same settings share one batch and one check per sample', async () => {
  const { service } = comparison();
  const original = await addModel('Scribe', 'm1');
  const copy = await addModel('Scribe again', 'm1');
  const [s1, s2] = await addSamples(3);

  const preview = await service.preview({ modelIds: [original, copy], count: 2 });

  assert.deepEqual(preview.checks, [
    { modelId: original, sampleId: s1, retry: false },
    { modelId: original, sampleId: s2, retry: false },
  ]);
});

test('the next automatic preview moves on to samples not checked yet', async () => {
  const { service } = comparison();
  const modelId = await addModel('Scribe', 'm1');
  const [, , s3, s4] = await addSamples(5);
  const first = await service.preview({ modelIds: [modelId], count: 2 });
  for (const check of first.checks) await service.check(check);

  const next = await service.preview({ modelIds: [modelId], count: 2 });

  assert.deepEqual(
    next.checks.map((check) => check.sampleId),
    [s3, s4],
  );
});

test('when every engine has checked every sample, there is nothing to run', async () => {
  const { service } = comparison();
  const modelId = await addModel('Scribe', 'm1');
  const [s1, s2] = await addSamples(2);
  await service.check({ modelId, sampleId: s1 });
  await service.check({ modelId, sampleId: s2 });

  const preview = await service.preview({ modelIds: [modelId], count: 5 });

  assert.equal(preview.newChecks, 0);
});

test('a count above 100 is rejected, and 100 is accepted', async () => {
  const { service } = comparison();
  const modelId = await addModel('Scribe', 'm1');
  await addSamples(1);

  await assert.rejects(service.preview({ modelIds: [modelId], count: 101 }), BadRequestException);
  await assert.doesNotReject(service.preview({ modelIds: [modelId], count: 100 }));
});

test('more than 100 sample ids are rejected even with duplicates, and 100 are accepted', async () => {
  const { service } = comparison();
  const modelId = await addModel('Scribe', 'm1');
  const sampleIds = await addSamples(100);

  await assert.rejects(
    service.preview({ modelIds: [modelId], sampleIds: [...sampleIds, sampleIds[0]] }),
    BadRequestException,
  );
  await assert.doesNotReject(service.preview({ modelIds: [modelId], sampleIds }));
});

test('a run that needs more than 100 new checks is rejected, and exactly 100 is accepted', async () => {
  const { service } = comparison();
  const scribe = await addModel('Scribe', 'm1');
  const hispeech = await addModel('HiSpeech', 'm2');
  const sampleIds = await addSamples(51);
  await service.check({ modelId: hispeech, sampleId: sampleIds[0] });

  await assert.rejects(
    service.preview({ modelIds: [scribe, hispeech], sampleIds }),
    /This run needs 101 new checks\. A run can send at most 100\./,
  );
  await service.check({ modelId: hispeech, sampleId: sampleIds[1] });
  const accepted = await service.preview({ modelIds: [scribe, hispeech], sampleIds });
  assert.equal(accepted.newChecks, 100);
});

/** Keeps attempt times apart, so "most recent" is never a tie. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('a model whose last 3 attempts failed needs review, with its failures newest first', async () => {
  const { fake, service } = comparison();
  const modelId = await addModel('Scribe', 'm1');
  const [s1, s2, s3, s4] = await addSamples(5);
  await service.check({ modelId, sampleId: s1 });
  fake.failWith('ElevenLabs rejected this API key.');
  for (const sampleId of [s2, s3, s4]) {
    await tick();
    await assert.rejects(service.check({ modelId, sampleId }));
  }

  const [model] = (await service.preview({ modelIds: [modelId], count: 1 })).models;

  assert.equal(model.needsReview, true);
  assert.deepEqual(
    model.recentFailures.map((failure) => [failure.sampleId, failure.error]),
    [
      [s4, 'ElevenLabs rejected this API key.'],
      [s3, 'ElevenLabs rejected this API key.'],
      [s2, 'ElevenLabs rejected this API key.'],
    ],
  );
});

test('a success among the last 3 attempts means no review', async () => {
  const { fake, service } = comparison();
  const modelId = await addModel('Scribe', 'm1');
  const [s1, s2, s3] = await addSamples(4);
  fake.failWith('Could not reach ElevenLabs.');
  for (const sampleId of [s1, s2]) {
    await tick();
    await assert.rejects(service.check({ modelId, sampleId }));
  }
  fake.failWith(null);
  await tick();
  await service.check({ modelId, sampleId: s3 });

  const [model] = (await service.preview({ modelIds: [modelId], count: 1 })).models;

  assert.equal(model.needsReview, false);
});
