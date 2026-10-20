import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CallRecording } from './call-recording';

describe('call recording', () => {
  it('mixes the caller and the agent into one wav', () => {
    let now = 0;
    const recording = new CallRecording(() => now);
    recording.addCaller(Int16Array.from([1000, 1000]));
    now = 1000;
    recording.addAgent(Int16Array.from([2000]));
    const mix = recording.mix();
    assert.equal(mix.wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(mix.peaks.length, 240);
    assert.ok(mix.durationMs >= 1000);
  });
});
