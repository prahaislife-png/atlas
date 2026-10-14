import crypto from 'node:crypto';

export function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('en-US').trim();
}

export function brandMentioned(text, aliases) {
  const haystack = normalize(text);
  return (aliases ?? []).filter(Boolean).some(alias => {
    const escaped = normalize(alias).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'u').test(haystack);
  });
}

export function getResponseText(response) {
  if (typeof response?.output_text === 'string') return response.output_text;
  return (response?.output ?? [])
    .filter(item => item.type === 'message')
    .flatMap(item => item.content ?? [])
    .filter(c => c.type === 'output_text')
    .map(c => c.text ?? '')
    .join('\n');
}

export function extractCitations(response) {
  const annotations = (response?.output ?? [])
    .filter(item => item.type === 'message')
    .flatMap(item => item.content ?? [])
    .flatMap(c => c.annotations ?? [])
    .filter(a => a.type === 'url_citation' && typeof a.url === 'string');
  const citations = annotations.flatMap(annotation => {
    try {
      const parsed = new URL(annotation.url);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return [];
      return [{ url: parsed.href, title: annotation.title || parsed.hostname }];
    } catch {
      return [];
    }
  });
  return [...new Map(citations.map(c => [c.url, c])).values()];
}

export function summarize(observations, project) {
  const real = observations.filter(o => o.mode === 'live');
  const sample = observations.filter(o => o.mode === 'sample');
  const data = real.length ? real : sample;
  const denominator = data.length || 1;
  const mentioned = data.filter(o => o.brandMentioned).length;
  const cited = data.filter(o => o.targetCited).length;
  const competitors = [...new Set(data.flatMap(o => o.competitorsMentioned ?? []))];
  return {
    source: real.length ? 'live' : sample.length ? 'sample' : 'empty',
    observations: data.length,
    mentionRate: Math.round(100 * mentioned/denominator),
    citationRate: Math.round(100 * cited/denominator),
    competitorCount: competitors.length,
    trackedPrompts: project.prompts.length,
    latestRun: data.map(o=>o.createdAt).sort().at(-1) ?? null
  };
}

export function evaluate(response, project, prompt) {
  const answer = getResponseText(response);
  const citations = extractCitations(response);
  const target = new URL(project.domain).hostname.replace(/^www\./, '').toLowerCase();
  const hostFromUrl = url => {try{return new URL(url).hostname.replace(/^www\./, '')}catch{return ''}};
  return {
    id:crypto.randomUUID(), promptId:prompt.id, prompt:prompt.text,
    language:prompt.language, intent:prompt.intent,
    mode:'live', engine:'OpenAI Responses API · web_search',
    createdAt:new Date().toISOString(), answer,
    brandMentioned:brandMentioned(answer,[project.brand,...(project.aliases ?? [])]),
    targetCited:citations.some(c=>hostFromUrl(c.url)===target || hostFromUrl(c.url).endsWith('.'+target)),
    competitorsMentioned:project.competitors.filter(name=>brandMentioned(answer,[name])),
    citations
  };
}
