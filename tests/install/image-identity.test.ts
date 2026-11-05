import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageMatches, isImagePin } from '../../src/isolation/image.ts';

test('immutable local image identity and registry digests match only inspected image metadata', () => {
  const id='sha256:'+'a'.repeat(64); const digest='example/image@sha256:'+'b'.repeat(64);
  assert.equal(isImagePin(id),true); assert.equal(isImagePin(digest),true); assert.equal(isImagePin('image:latest'),false);
  assert.equal(imageMatches(id,{Id:id,RepoDigests:[]}),true);
  assert.equal(imageMatches(id,{Id:'sha256:'+'c'.repeat(64),RepoDigests:[]}),false);
  assert.equal(imageMatches(digest,{Id:id,RepoDigests:[digest]}),true);
  assert.equal(imageMatches(digest,{Id:id,RepoDigests:[]}),false);
});
