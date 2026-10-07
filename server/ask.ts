// Edge Function "ask": responde a uma conversa no servidor, para a resposta não se perder
// quando a app vai para segundo plano no telemóvel.
//
// O site grava a pergunta na tabela "chats" e chama esta função com { chat_id, api_key, provider, model }.
// A função responde logo { ok: true } e continua a trabalhar em segundo plano (EdgeRuntime.waitUntil):
// lê o índice dos posts, usa as ferramentas, e grava a resposta na mesma linha de "chats" (status = 'done').
// A chave da IA vem em cada pedido e não fica guardada em lado nenhum.

import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const MODELS: Record<string, Record<string, string>> = {
  anthropic: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' },
  openrouter: { opus: 'anthropic/claude-opus-5.5', sonnet: 'anthropic/claude-sonnet-5.5' }
};

const CHAT_PROMPT = `És o assistente de leitura pessoal do utilizador. Ele guarda posts e artigos do X (Twitter) e quer ajuda para tirar partido deles.

Em baixo está o ÍNDICE de tudo o que ele guardou: número, tópicos, autor, data, título e resumo. O índice só tem resumos — para avaliar, comparar, recomendar ou citar posts, lê-os primeiro com a ferramenta ler_artigos (podes ler vários de uma vez; devolve o texto completo, incluindo artigos longos). Usa procurar quando ele pergunta por algo específico que pode não estar nos resumos.

Quando recomendas, sê honesto e crítico: diz quais valem a pena e porquê, e quais são fracos. Refere os posts pelo autor e inclui o link do post (o url que vem no índice/artigo) para ele o poder abrir. Responde em português de Portugal, direto e sem floreados.`;

const POST_PROMPT = `És o assistente de leitura do utilizador. Ele está a ler o post/artigo abaixo, que guardou do X, e quer conversar sobre ele.

Responde em português de Portugal, direto e sem floreados. Baseia-te no conteúdo do post; se algo não estiver lá, diz isso antes de acrescentares conhecimento geral. Podes resumir, criticar, extrair passos práticos, explicar termos ou dizer se vale a pena.`;

const TOOLS = [
  {
    name: 'ler_artigos',
    description: 'Lê o texto completo de posts do índice, pelos seus números. Usa antes de avaliar, comparar, resumir em detalhe ou recomendar. Até 10 posts por chamada.',
    input_schema: {
      type: 'object',
      properties: { numeros: { type: 'array', items: { type: 'integer' }, description: 'Números (#) dos posts no índice.' } },
      required: ['numeros'],
      additionalProperties: false
    }
  },
  {
    name: 'procurar',
    description: 'Procura uma palavra ou expressão no texto de todos os posts guardados (não distingue maiúsculas). Devolve os números e títulos dos posts onde aparece.',
    input_schema: {
      type: 'object',
      properties: { termo: { type: 'string' } },
      required: ['termo'],
      additionalProperties: false
    }
  }
];

type Article = {
  id: string; url: string; author: string | null; title: string | null; summary: string | null;
  topics: string[] | null; text: string; posted_at: string | null; saved_at: string;
};
type Display = { role: string; text: string };

// ---------- post completo via FxTwitter (texto inteiro, artigos longos, citação) ----------
async function fetchFx(url: string): Promise<any | null> {
  const id = url.match(/status\/(\d+)/)?.[1];
  if (!id) return null;
  const get = (u: string) => fetch(u, { signal: AbortSignal.timeout(8000) }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  const [one, th] = await Promise.all([get(`https://api.fxtwitter.com/i/status/${id}`), get(`https://api.fxtwitter.com/2/thread/${id}`)]);
  const t = one?.tweet ?? null;
  // continuação da thread: posts seguintes do mesmo autor
  if (t && Array.isArray(th?.thread) && th.thread.length > 1 && th.thread[0]?.id === id) t._thread = th.thread.slice(1);
  return t;
}

// Imagens do post (para o modelo as poder ver), em tamanho médio.
function fxImages(t: any): string[] {
  if (!t) return [];
  const urls: string[] = [];
  const add = (u?: string) => {
    if (!u) return;
    const v = u.includes('pbs.twimg.com/media') ? u.replace(/name=\w+/, 'name=medium') : u;
    if (!urls.includes(v)) urls.push(v);
  };
  if (t.article) {
    add(t.article.cover_media?.media_info?.original_img_url);
    for (const m of t.article.media_entities || []) if (!m.media_info?.variants) add(m.media_info?.original_img_url);
  }
  for (const m of t.media?.all || []) add(m.type === 'photo' ? m.url : m.thumbnail_url);
  for (const p of t._thread || []) for (const m of p.media?.all || []) add(m.type === 'photo' ? m.url : m.thumbnail_url);
  for (const m of t.quote?.media?.all || []) add(m.type === 'photo' ? m.url : m.thumbnail_url);
  return urls.slice(0, 6);
}

function fxToText(t: any): string {
  if (!t) return '';
  if (t.article) {
    const blocks = (t.article.content?.blocks || []).map((b: any) => b.type === 'atomic' ? '[imagem]' : b.text).filter(Boolean);
    return `Título: ${t.article.title}\n\n${blocks.join('\n\n')}`;
  }
  let s = t.text || '';
  if (t.quote) s += `\n\n[Post citado de @${t.quote.author?.screen_name}]\n${t.quote.text || ''}`;
  if (t.media?.all?.length) s += `\n\n[${t.media.all.length} imagem/vídeo no post]`;
  if (t._thread?.length) {
    s += `\n\n[Continuação da thread — mais ${t._thread.length} posts do autor]`;
    t._thread.forEach((p: any, i: number) => {
      s += `\n\n(${i + 2}) ${p.text || ''}${p.media?.all?.length ? ` [${p.media.all.length} imagem/vídeo]` : ''}`;
    });
  }
  return s;
}

async function fullText(a: Article): Promise<string> {
  const fx = fxToText(await fetchFx(a.url));
  return fx.length > (a.text || '').length * 0.8 ? fx : a.text;
}

// ---------- índice e ferramentas ----------
function buildIndex(items: Article[]): string {
  return items.map((a, i) =>
    `#${i + 1} | ${(a.topics || []).join(', ') || 'sem tópico'} | ${a.author || ''} | ${(a.posted_at || a.saved_at).slice(0, 10)} | ${a.url} | ${a.title || ''} — ${a.summary || a.text.slice(0, 200).replace(/\s+/g, ' ')}`
  ).join('\n');
}

async function runTool(name: string, input: any, items: Article[]): Promise<{ text: string; label: string; error?: boolean }> {
  if (name === 'ler_artigos') {
    if (!Array.isArray(input?.numeros)) return { text: 'numeros tem de ser uma lista de inteiros.', label: '', error: true };
    const nums: number[] = input.numeros.slice(0, 10);
    const parts = await Promise.all(nums.map(async n => {
      const a = items[n - 1];
      if (!a) return `#${n}: não existe.`;
      return `<artigo n="${n}" autor="${a.author || ''}" data="${(a.posted_at || a.saved_at).slice(0, 10)}" url="${a.url}">\n${a.title || ''}\n\n${(await fullText(a)).slice(0, 40000)}\n</artigo>`;
    }));
    return { text: parts.join('\n\n'), label: `📖 A ler ${nums.map(n => '#' + n).join(', ')}` };
  }
  if (name === 'procurar') {
    const termo = String(input?.termo || '').trim().toLowerCase();
    if (!termo) return { text: 'termo em falta.', label: '', error: true };
    const hits = items.map((a, i) => ({ a, n: i + 1 }))
      .filter(({ a }) => `${a.title} ${a.author} ${a.summary} ${a.text}`.toLowerCase().includes(termo))
      .slice(0, 50);
    return {
      text: hits.length ? hits.map(({ a, n }) => `#${n} ${a.title || a.text.slice(0, 80)} (${a.url})`).join('\n') : 'Nenhum post contém esse termo.',
      label: `🔎 A procurar “${input.termo}” (${hits.length})`
    };
  }
  return { text: 'Ferramenta desconhecida.', label: '', error: true };
}

// Histórico simples (só texto) a partir do que está guardado na conversa, com papéis alternados.
function toHistory(display: Display[]) {
  const out: { role: string; content: string }[] = [];
  for (const m of display) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.text;
    else out.push({ role: m.role, content: m.text });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

// ---------- chamadas à IA ----------
async function callOpenRouter(apiKey: string, model: string, system: string, history: any[], useTools: boolean, activity: string[], items: Article[]) {
  const tools = TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const messages: any[] = [...history];
  const sys = { role: 'system', content: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] };
  let answer = '';
  for (let round = 0; round < 10; round++) {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'X-Title': 'X Memoria' },
      body: JSON.stringify({ model, max_tokens: 16000, reasoning: { effort: 'medium' }, ...(useTools ? { tools } : {}), messages: [sys, ...messages] })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw new Error(`OpenRouter ${r.status}: ${d.error?.message || r.statusText}`);
    const msg = d.choices?.[0]?.message || {};
    if (msg.content) answer += (answer ? '\n\n' : '') + msg.content;
    const turn: any = { role: 'assistant', content: msg.content || '' };
    if (msg.tool_calls?.length) turn.tool_calls = msg.tool_calls;
    if (msg.reasoning_details) turn.reasoning_details = msg.reasoning_details;
    messages.push(turn);
    if (!msg.tool_calls?.length) return answer;
    for (const tc of msg.tool_calls) {
      let input = null;
      try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* inválido */ }
      const res = input ? await runTool(tc.function.name, input, items) : { text: 'Argumentos inválidos (JSON).', label: '', error: true };
      if (res.label) activity.push(res.label);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: res.error ? 'Erro: ' + res.text : res.text });
    }
  }
  return answer || '(parei: demasiados passos seguidos)';
}

async function callAnthropic(apiKey: string, model: string, system: string, history: any[], useTools: boolean, activity: string[], items: Article[]) {
  const messages: any[] = [...history];
  let answer = '';
  for (let round = 0; round < 10; round++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01'
      },
      body: JSON.stringify({
        model, max_tokens: 16000, output_config: { effort: 'medium' }, fallbacks: 'default',
        cache_control: { type: 'ephemeral' }, system, ...(useTools ? { tools: TOOLS } : {}), messages
      })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${d.error?.message || r.statusText}`);
    const text = (d.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    if (text) answer += (answer ? '\n\n' : '') + text;
    messages.push({ role: 'assistant', content: d.content?.length ? d.content : '(sem resposta)' });
    if (d.stop_reason === 'refusal' && !answer) return '(O modelo recusou responder a este pedido.)';
    if (d.stop_reason !== 'tool_use') return answer;
    const results = [];
    for (const b of (d.content || []).filter((x: any) => x.type === 'tool_use')) {
      const res = await runTool(b.name, b.input, items);
      if (res.label) activity.push(res.label);
      results.push({ type: 'tool_result', tool_use_id: b.id, content: res.text, ...(res.error ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }
  return answer || '(parei: demasiados passos seguidos)';
}

// ---------- trabalho em segundo plano ----------
async function work(sb: any, req: { chat_id: string; api_key: string; provider: string; model: string }) {
  const { data: chat, error } = await sb.from('chats').select('*').eq('id', req.chat_id).single();
  if (error || !chat) throw new Error('Conversa não encontrada');
  const display: Display[] = Array.isArray(chat.messages) ? chat.messages : [];
  const provider = req.provider === 'anthropic' ? 'anthropic' : 'openrouter';
  const model = MODELS[provider][String(req.model).includes('sonnet') ? 'sonnet' : 'opus'];
  const history = toHistory(display);
  const activity: string[] = [];

  let system: string, useTools: boolean, items: Article[] = [];
  let images: string[] = [];
  if (chat.post_url) {
    // conversa sobre um post: o post completo (com a thread) é o contexto
    const fx = await fetchFx(chat.post_url);
    images = fxImages(fx);
    let context = fxToText(fx);
    if (!context) {
      const { data: a } = await sb.from('articles').select('text,author').eq('url', chat.post_url).maybeSingle();
      context = a ? `Autor: ${a.author}\n\n${a.text}` : '(post indisponível)';
    } else if (fx?.author) {
      context = `Autor: ${fx.author.name} (@${fx.author.screen_name})\n\n${context}`;
    }
    system = `${POST_PROMPT}\n\n<post url="${chat.post_url}">\n${context}\n</post>`;
    useTools = false;
  } else {
    const { data: rows, error: e2 } = await sb.from('articles')
      .select('id,url,author,title,summary,topics,text,posted_at,saved_at')
      .order('saved_at', { ascending: true }).limit(5000);
    if (e2) throw new Error(e2.message);
    items = rows || [];
    system = `${CHAT_PROMPT}\n\n<indice total="${items.length}">\n${buildIndex(items) || '(vazio)'}\n</indice>`;
    useTools = true;
  }

  // As imagens do post vão junto da primeira pergunta, para o modelo as ver.
  if (images.length && history.length) {
    const first: any = history[0];
    const text = `(Imagens do post em anexo)\n\n${first.content}`;
    first.content = provider === 'anthropic'
      ? [...images.map(url => ({ type: 'image', source: { type: 'url', url } })), { type: 'text', text }]
      : [{ type: 'text', text }, ...images.map(url => ({ type: 'image_url', image_url: { url } }))];
  }

  const answer = provider === 'anthropic'
    ? await callAnthropic(req.api_key, model, system, history, useTools, activity, items)
    : await callOpenRouter(req.api_key, model, system, history, useTools, activity, items);

  // relê a conversa (pode ter mudado entretanto) e acrescenta a resposta
  const { data: fresh } = await sb.from('chats').select('messages').eq('id', req.chat_id).single();
  const msgs: Display[] = Array.isArray(fresh?.messages) ? fresh.messages : display;
  for (const a of activity) msgs.push({ role: 'activity', text: a });
  msgs.push({ role: 'assistant', text: answer || '(sem resposta)' });
  await sb.from('chats').update({ messages: msgs, status: 'done', error: null, updated_at: new Date().toISOString() }).eq('id', req.chat_id);
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Só POST' }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'JSON inválido' }, 400); }
  if (!body?.chat_id || !body?.api_key) return json({ error: 'Faltam chat_id ou api_key' }, 400);

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  await sb.from('chats').update({ status: 'thinking', error: null }).eq('id', body.chat_id);

  const job = work(sb, body).catch(async (e: Error) => {
    await sb.from('chats').update({ status: 'error', error: String(e?.message || e).slice(0, 500) }).eq('id', body.chat_id);
  });
  // @ts-ignore EdgeRuntime existe no Supabase
  EdgeRuntime.waitUntil(job);
  return json({ ok: true });
});
