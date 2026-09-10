// Provider-agnostic "what should be cleaned out of this scan" call.
// OpenAI and xAI both speak the chat-completions shape with image_url parts.
import { parseResponse, requestBody } from './aiprompt.mjs';

const ENDPOINTS = {
  openai: { url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-5.5' },
  xai:    { url: 'https://api.x.ai/v1/chat/completions',       model: 'grok-4.3' },
};

export async function suggest({ provider, model, key, images, context }) {
  const ep = ENDPOINTS[provider];
  const body = requestBody(provider, model || ep.model, images, context);
  const t0 = Date.now();
  const res = await fetch(ep.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${provider} ${res.status}: ${text.slice(0, 400)}`);
  const json = JSON.parse(text);
  const content = json.choices?.[0]?.message?.content ?? '';
  const parsed = parseResponse(content);
  return { provider, model: body.model, ms: Date.now() - t0, usage: json.usage ?? null, ...parsed };
}
