import { COMPATIBLE_PROVIDER_ENDPOINTS } from './compatible-provider-endpoints.ts';

// Only these implemented protocols and fixed hosts may receive a user's credentials.
// Catalog metadata and browser requests cannot supply an arbitrary credential destination.
export const PROVIDER_ENDPOINTS: Record<string, string> = {
	...COMPATIBLE_PROVIDER_ENDPOINTS,
	openai: 'https://api.openai.com/v1',
	anthropic: 'https://api.anthropic.com/v1',
	openrouter: 'https://openrouter.ai/api/v1',
	google: 'https://generativelanguage.googleapis.com/v1beta',
	groq: 'https://api.groq.com/openai/v1',
	deepseek: 'https://api.deepseek.com',
	xai: 'https://api.x.ai/v1',
	mistral: 'https://api.mistral.ai/v1',
	cerebras: 'https://api.cerebras.ai/v1',
	deepinfra: 'https://api.deepinfra.com/v1/openai',
	togetherai: 'https://api.together.xyz/v1',
	'fireworks-ai': 'https://api.fireworks.ai/inference/v1',
	perplexity: 'https://api.perplexity.ai',
	cohere: 'https://api.cohere.com/compatibility/v1',
	nvidia: 'https://integrate.api.nvidia.com/v1',
	baseten: 'https://inference.baseten.co/v1'
};
