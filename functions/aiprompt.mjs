// Prompt and response parsing shared by the Cloud Function and the browser fallback.
// Protocol: image 1 is a gridded top-down render with numbered candidate boxes (found
// locally from colour + surface roughness); image 2 is an oblique view for context.
// The model decides per candidate, may add boxes of its own (image fractions), and may
// propose height sections. Geometry stays tight because candidates come from the data.

export function buildPrompt(ctx) {
  const { extentX, extentY, zMin, zMax, candidates = [], kinds, closeups = 0 } = ctx;
  const want = kinds?.length ? kinds.join(', ') : 'vegetation (trees, bushes, hedges), vehicles, people, scanning artefacts and floating noise, temporary objects';
  const cand = candidates.length
    ? `Orange boxes labelled C1…C${candidates.length} in image 1 are candidate removals found by a local detector (honouring the selected kinds):\n` +
      candidates.map(c => `  ${c.id}: ${c.area.toFixed(0)} m² footprint, ${c.height.toFixed(1)} m tall, at x=${c.x.toFixed(0)} y=${c.y.toFixed(0)} m`).join('\n') +
      `\nFor EACH candidate say whether to remove it and what it is.` +
      (closeups ? `\nImages 3 to ${2 + closeups} are close-ups of C1 to C${closeups} in that order, each with its box drawn in orange; judge mainly from the close-up whether the box holds vegetation or other removable stuff, or a piece of a building (roof, wall, terrace, balcony).` : '')
    : 'No candidates were pre-detected; find removable objects yourself.';
  return `You help a surveyor clean a LiDAR point cloud of a site. You will see two renders of the same scan.
Image 1 is a TOP-DOWN view with a labelled 10 m grid. It covers x from 0 to ${extentX.toFixed(1)} m (left to right) and y from 0 to ${extentY.toFixed(1)} m (bottom to top). Heights run from ${zMin.toFixed(1)} to ${zMax.toFixed(1)} m; sections are given as heights above the lowest point.
Image 2 is an oblique overview for context only; never report coordinates from it.
${cand}
Things to remove so the built structures and ground remain: ${want}.
NEVER remove buildings, walls, roofs, roads, ground, stairs, fences or terraces. A candidate on a roof or wall is a detector error: keep it.
Then look at image 1 for removable objects NOT covered by any candidate — parked cars, canopies rendered white by sunlight, bushes, poles, floating noise — and list each as an additional box, given as fractions of image 1 with (0,0) top-left and (1,1) bottom-right. Keep them tight, one per object or clump; they are refined against the data afterwards. Do not repeat a candidate.
Answer with JSON only, exactly this shape:
{"candidates":[{"id":"C1","remove":true,"label":"tree","confidence":0.9,"reason":"round canopy east of the house"}],
 "additional":[{"label":"car","x0":0.61,"y0":0.42,"x1":0.66,"y1":0.47,"confidence":0.7,"reason":"parked on the street"}],
 "sections":[{"label":"foliage above the roof line","from":9.5,"to":40,"confidence":0.5,"reason":"only canopy exists above this height"}]}
Use "sections" only when everything above or below a height is removable everywhere; otherwise return an empty list. At most 24 additional boxes.`;
}

/** Chat-completions body. Reasoning models (gpt-5*, o*) reject temperature/max_tokens, so those are model-gated. */
export function requestBody(provider, model, images, context) {
  const reasoning = /^(gpt-5|o\d)/.test(model);
  const body = {
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'You are a precise geospatial assistant. Output valid JSON only.' },
      { role: 'user', content: [
        { type: 'text', text: buildPrompt(context) },
        ...images.map(i => ({ type: 'image_url', image_url: { url: i.dataUrl, detail: i.detail || 'high' } })),
      ] },
    ],
  };
  if (!reasoning) body.temperature = 0.1;
  if (provider === 'openai') { body.max_completion_tokens = 4000; if (reasoning) body.reasoning_effort = 'low'; }
  else body.max_tokens = 4000;
  return body;
}

export function parseResponse(content) {
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { const m = String(content).match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : {}; }
  const num = (v, d = 0) => (v == null || isNaN(+v)) ? d : +v;
  const conf = (v) => Math.max(0, Math.min(1, num(v, 0.5)));
  const str = (v, n = 60) => String(v ?? '').slice(0, n);
  const candidates = (parsed.candidates ?? []).map(c => ({ id: str(c.id, 8), remove: c.remove === true || c.remove === 'true', label: str(c.label) || 'object', confidence: conf(c.confidence), reason: str(c.reason, 200) }));
  const additional = (parsed.additional ?? parsed.suggestions ?? []).filter(s => s.kind !== 'section')
    .map((s, i) => ({ id: `ai-${Date.now().toString(36)}-${i}`, label: str(s.label) || 'object', x0: num(s.x0), y0: num(s.y0), x1: num(s.x1), y1: num(s.y1), zFrom: s.zFrom == null ? null : num(s.zFrom), zTo: s.zTo == null ? null : num(s.zTo), confidence: conf(s.confidence), reason: str(s.reason, 200) }))
    .filter(s => s.x1 > s.x0 && s.y1 > s.y0 && s.x0 >= 0 && s.y0 >= 0 && s.x1 <= 1 && s.y1 <= 1).slice(0, 24);
  const sections = (parsed.sections ?? (parsed.suggestions ?? []).filter(s => s.kind === 'section')).map((s, i) => ({ id: `ai-sec-${Date.now().toString(36)}-${i}`, label: str(s.label) || 'section', from: s.from == null ? null : num(s.from), to: s.to == null ? null : num(s.to), confidence: conf(s.confidence), reason: str(s.reason, 200) }))
    .filter(s => s.from != null || s.to != null).slice(0, 4);
  return { candidates, additional, sections };
}
