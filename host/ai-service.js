'use strict';

/*
 * OpenAI-compatible AI transport (ported from the original reader).
 *
 * The renderer owns the provider settings and sends them per request; this
 * module only performs the HTTP call, so no key is ever stored on disk by the
 * host. `stream:false` keeps the UI simple: the panel shows 思考中… until the
 * whole answer arrives, exactly like the original.
 */

const DEFAULT_SYSTEM = '你是一位资深 C/C++ 与系统软件工程师，回答用中文：先给结论，再给必要依据；'
  + '不要客套话，不要重复我贴的代码。';
const TIMEOUT_MS = 180000;

function normalizeBase(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (raw === '') throw new Error('没有设置 Base URL');
  const url = raw.replace(/\/+$/, '');
  if (!/^https?:\/\//iu.test(url)) throw new Error('Base URL 必须以 http:// 或 https:// 开头');
  return url;
}

function authHeaders(apiKey) {
  const headers = { 'content-type': 'application/json' };
  if (typeof apiKey === 'string' && apiKey !== '') headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

async function request(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = null;
    try {
      data = text === '' ? null : JSON.parse(text);
    } catch {
      data = null;
    }
    if (!response.ok) {
      const message = data?.error?.message || data?.message || text || `HTTP ${response.status}`;
      throw new Error(String(message).slice(0, 500));
    }
    return data;
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('请求超时（180 秒）');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One non-streaming chat completion.
 * @param {{baseUrl:string, apiKey?:string, model?:string, messages:Array<{role:string,content:string}>, system?:string}} input
 */
async function chat(input) {
  const base = normalizeBase(input?.baseUrl);
  const messages = Array.isArray(input?.messages)
    ? input.messages.filter((item) => item && typeof item.content === 'string' && item.content !== '')
      .map((item) => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: item.content }))
    : [];
  if (messages.length === 0) throw new Error('没有可发送的内容');
  const body = {
    model: String(input?.model || '').trim() || undefined,
    stream: false,
    messages: input?.system === false
      ? messages
      : [{ role: 'system', content: String(input?.system || DEFAULT_SYSTEM) }, ...messages],
  };
  const data = await request(`${base}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(input?.apiKey),
    body: JSON.stringify(body),
  });
  const content = data?.choices?.[0]?.message?.content ?? data?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('模型没有返回可用的文本');
  }
  return { ok: true, content, model: data?.model || body.model || '' };
}

/** `GET {baseUrl}/models` — the panel's model picker. */
async function listModels(input) {
  const base = normalizeBase(input?.baseUrl);
  const data = await request(`${base}/models`, {
    method: 'GET',
    headers: authHeaders(input?.apiKey),
  });
  const models = Array.isArray(data?.data)
    ? data.data.map((item) => String(item?.id || '')).filter((id) => id !== '')
    : [];
  return { ok: true, models };
}

module.exports = { chat, listModels, DEFAULT_SYSTEM };
