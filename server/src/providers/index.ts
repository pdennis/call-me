/**
 * Provider Factory
 *
 * Creates and configures providers based on environment variables.
 * Supports Telnyx or Twilio for phone; OpenAI or Kokoro for TTS; OpenAI Realtime
 * or a local OpenAI-compatible endpoint for STT.
 */

import type { PhoneProvider, TTSProvider, RealtimeSTTProvider, ProviderRegistry } from './types.js';
import { TelnyxPhoneProvider } from './phone-telnyx.js';
import { TwilioPhoneProvider } from './phone-twilio.js';
import { OpenAITTSProvider } from './tts-openai.js';
import { KokoroTTSProvider } from './tts-kokoro.js';
import { OpenAIRealtimeSTTProvider } from './stt-openai-realtime.js';
import { LocalSTTProvider } from './stt-local.js';

export * from './types.js';

export type PhoneProviderType = 'telnyx' | 'twilio';
export type TTSProviderType = 'openai' | 'kokoro';
export type STTProviderType = 'openai' | 'local';

export interface ProviderConfig {
  // Phone provider selection
  phoneProvider: PhoneProviderType;

  // TTS provider selection
  ttsProvider: TTSProviderType;

  // STT provider selection
  sttProvider: STTProviderType;

  // Phone credentials (interpretation depends on provider)
  // Telnyx: accountSid = Connection ID, authToken = API Key
  // Twilio: accountSid = Account SID, authToken = Auth Token
  phoneAccountSid: string;
  phoneAuthToken: string;
  phoneNumber: string;

  // Telnyx webhook public key (for signature verification)
  // Get from: Mission Control > Account Settings > Keys & Credentials > Public Key
  telnyxPublicKey?: string;

  // OpenAI (STT, and TTS when ttsProvider is 'openai')
  openaiApiKey: string;
  ttsVoice?: string;
  sttModel?: string;
  sttSilenceDurationMs?: number;

  // Kokoro TTS (when ttsProvider is 'kokoro')
  kokoroUrl?: string;

  // Local STT (when sttProvider is 'local'): OpenAI-compatible /v1 base URL
  sttUrl?: string;
  sttLanguage?: string;
  sttVadThreshold?: number;
}

export function loadProviderConfig(): ProviderConfig {
  const sttSilenceDurationMs = process.env.CALLME_STT_SILENCE_DURATION_MS
    ? parseInt(process.env.CALLME_STT_SILENCE_DURATION_MS, 10)
    : undefined;

  // Default to telnyx if not specified
  const phoneProvider = (process.env.CALLME_PHONE_PROVIDER || 'telnyx') as PhoneProviderType;
  const ttsProvider = (process.env.CALLME_TTS_PROVIDER || 'openai') as TTSProviderType;
  const sttProvider = (process.env.CALLME_STT_PROVIDER || 'openai') as STTProviderType;

  return {
    phoneProvider,
    ttsProvider,
    sttProvider,
    phoneAccountSid: process.env.CALLME_PHONE_ACCOUNT_SID || '',
    phoneAuthToken: process.env.CALLME_PHONE_AUTH_TOKEN || '',
    phoneNumber: process.env.CALLME_PHONE_NUMBER || '',
    telnyxPublicKey: process.env.CALLME_TELNYX_PUBLIC_KEY,
    openaiApiKey: process.env.CALLME_OPENAI_API_KEY || '',
    ttsVoice: process.env.CALLME_TTS_VOICE || undefined,
    sttModel: process.env.CALLME_STT_MODEL || (sttProvider === 'local' ? undefined : 'gpt-4o-transcribe'),
    sttSilenceDurationMs,
    kokoroUrl: process.env.CALLME_KOKORO_URL,
    sttUrl: process.env.CALLME_STT_URL || undefined,
    sttLanguage: process.env.CALLME_STT_LANGUAGE || 'en',
    sttVadThreshold: process.env.CALLME_STT_VAD_THRESHOLD
      ? parseInt(process.env.CALLME_STT_VAD_THRESHOLD, 10)
      : undefined,
  };
}

export function createPhoneProvider(config: ProviderConfig): PhoneProvider {
  let provider: PhoneProvider;

  if (config.phoneProvider === 'twilio') {
    provider = new TwilioPhoneProvider();
  } else {
    provider = new TelnyxPhoneProvider();
  }

  provider.initialize({
    accountSid: config.phoneAccountSid,
    authToken: config.phoneAuthToken,
    phoneNumber: config.phoneNumber,
  });

  return provider;
}

export function createTTSProvider(config: ProviderConfig): TTSProvider {
  if (config.ttsProvider === 'kokoro') {
    const provider = new KokoroTTSProvider();
    provider.initialize({
      apiUrl: config.kokoroUrl,
      voice: config.ttsVoice || 'af_bella',
    });
    return provider;
  }

  const provider = new OpenAITTSProvider();
  provider.initialize({
    apiKey: config.openaiApiKey,
    voice: config.ttsVoice,
  });
  return provider;
}

export function createSTTProvider(config: ProviderConfig): RealtimeSTTProvider {
  if (config.sttProvider === 'local') {
    const provider = new LocalSTTProvider();
    provider.initialize({
      apiUrl: config.sttUrl,
      model: config.sttModel,
      language: config.sttLanguage,
      silenceDurationMs: config.sttSilenceDurationMs,
      vadThreshold: config.sttVadThreshold,
    });
    return provider;
  }

  const provider = new OpenAIRealtimeSTTProvider();
  provider.initialize({
    apiKey: config.openaiApiKey,
    model: config.sttModel,
    silenceDurationMs: config.sttSilenceDurationMs,
  });
  return provider;
}

export function createProviders(config: ProviderConfig): ProviderRegistry {
  return {
    phone: createPhoneProvider(config),
    tts: createTTSProvider(config),
    stt: createSTTProvider(config),
  };
}

/**
 * Validate that required config is present
 */
export function validateProviderConfig(config: ProviderConfig): string[] {
  const errors: string[] = [];

  // Provider-specific credential descriptions
  const credentialDesc = config.phoneProvider === 'twilio'
    ? { accountSid: 'Twilio Account SID', authToken: 'Twilio Auth Token' }
    : { accountSid: 'Telnyx Connection ID', authToken: 'Telnyx API Key' };

  if (!config.phoneAccountSid) {
    errors.push(`Missing CALLME_PHONE_ACCOUNT_SID (${credentialDesc.accountSid})`);
  }
  if (!config.phoneAuthToken) {
    errors.push(`Missing CALLME_PHONE_AUTH_TOKEN (${credentialDesc.authToken})`);
  }
  if (!config.phoneNumber) {
    errors.push('Missing CALLME_PHONE_NUMBER');
  }
  const needsOpenAI = config.sttProvider !== 'local' || config.ttsProvider !== 'kokoro';
  if (needsOpenAI && !config.openaiApiKey) {
    errors.push('Missing CALLME_OPENAI_API_KEY (needed unless CALLME_STT_PROVIDER=local and CALLME_TTS_PROVIDER=kokoro)');
  }
  if (config.sttProvider === 'local' && !config.sttUrl) {
    errors.push('Missing CALLME_STT_URL (OpenAI-compatible /v1 base URL for local speech-to-text)');
  }

  return errors;
}
