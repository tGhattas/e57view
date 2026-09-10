export interface AiCandidateCtx { id: string; area: number; height: number; x: number; y: number }
export interface AiContext { extentX: number; extentY: number; zMin: number; zMax: number; candidates?: AiCandidateCtx[]; kinds?: string[]; closeups?: number }
export interface AiDecision { id: string; remove: boolean; label: string; confidence: number; reason: string }
export interface AiBox { id: string; label: string; x0: number; y0: number; x1: number; y1: number; zFrom: number | null; zTo: number | null; confidence: number; reason: string }
export interface AiSection { id: string; label: string; from: number | null; to: number | null; confidence: number; reason: string }
export interface AiParsed { candidates: AiDecision[]; additional: AiBox[]; sections: AiSection[] }
export function buildPrompt(ctx: AiContext): string;
export function parseResponse(content: string): AiParsed;
export function requestBody(provider: 'openai' | 'xai', model: string, images: { dataUrl: string; detail?: string }[], context: AiContext): any;
