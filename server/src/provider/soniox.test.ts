import { describe, expect, it } from 'vitest';
import { providerConfig } from './soniox.js';

const base = { model: 'stt-rt-v5', clientReferenceId: 'session/1' };

describe('providerConfig', () => {
  it('requests one-way translation into the target language, in either direction', () => {
    expect(providerConfig({ ...base, sourceLanguage: 'es', translationTarget: 'en' })).toEqual({
      model: 'stt-rt-v5',
      audio_format: 'pcm_s16le',
      sample_rate: 16000,
      num_channels: 1,
      language_hints: ['es'],
      enable_language_identification: true,
      enable_endpoint_detection: true,
      client_reference_id: 'session/1',
      translation: { type: 'one_way', target_language: 'en' },
    });
    expect(providerConfig({ ...base, sourceLanguage: 'en', translationTarget: 'es' })).toMatchObject({
      language_hints: ['en'],
      translation: { type: 'one_way', target_language: 'es' },
    });
  });

  it('omits translation for a session without a translation stream', () => {
    const config = providerConfig({ ...base, sourceLanguage: 'es', translationTarget: null });
    expect(config).not.toHaveProperty('translation');
    expect(config.language_hints).toEqual(['es']);
  });

  it('never carries the API key', () => {
    for (const translationTarget of ['en', 'es', null] as const) {
      expect(providerConfig({ ...base, sourceLanguage: 'es', translationTarget })).not.toHaveProperty('api_key');
    }
  });
});
