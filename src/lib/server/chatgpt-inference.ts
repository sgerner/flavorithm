import type { ReasoningSettings } from '#lib/ai-connections.ts';
/** Official Sign in with ChatGPT plan inference, over the public Responses API. */
export class ChatGPTInferenceError extends Error {
	status: number;
	code?: string;
	constructor(message: string, status = 502, code?: string) {
		super(message);
		this.status = status;
		this.code = code;
		this.name = 'ChatGPTInferenceError';
	}
}
const MAX_RESPONSE_BYTES = 3_000_000;
const TIMEOUT_MS = 90_000;
const knownErrors: Record<string, string> = {
	subscription_sharing_usage_limit_exceeded:
		'Your ChatGPT plan usage limit for Flavorithm has been reached. Review your app limit in ChatGPT Settings → Usage, or explicitly choose an API-key connection.',
	subscription_sharing_usage_unavailable:
		'ChatGPT plan usage is temporarily unavailable. Try again later or explicitly choose another connection.',
	subscription_sharing_invalid_user:
		'Your ChatGPT connection needs to be renewed. Reconnect the selected account.',
	chatpass_v2_scope_not_authorized:
		'This connection has not been granted ChatGPT plan usage. Enable it from the connection settings.',
	chatpass_v2_invalid_authorization_context:
		'The ChatGPT connection is not authorized for this request. Reconnect or check the app registration.'
};
function upstreamFailure(value: unknown, status = 502): ChatGPTInferenceError {
	const body = value as { error?: { code?: string }; response?: { error?: { code?: string } } };
	const code =
		body?.error?.code || body?.response?.error?.code || (value as { code?: string })?.code;
	if (code && knownErrors[code])
		return new ChatGPTInferenceError(knownErrors[code], /limit/.test(code) ? 429 : status, code);
	if (status === 401)
		return new ChatGPTInferenceError(
			'Your ChatGPT connection needs to be renewed. Reconnect the selected account.',
			401,
			code
		);
	if (status === 403)
		return new ChatGPTInferenceError(
			'ChatGPT plan access was not authorized. Check the granted permissions, account eligibility, and app registration.',
			403,
			code
		);
	if (status === 429)
		return new ChatGPTInferenceError(
			'ChatGPT usage is currently limited. Review ChatGPT Settings → Usage or try again later.',
			429,
			code
		);
	return new ChatGPTInferenceError(
		'ChatGPT could not complete this request. No API-key billing was used as a fallback.',
		status >= 500 ? 502 : status,
		code
	);
}
async function limitedJson(response: Response) {
	if (Number(response.headers.get('content-length') || 0) > MAX_RESPONSE_BYTES)
		throw new ChatGPTInferenceError('ChatGPT returned an oversized response.');
	if (!response.body) throw new ChatGPTInferenceError('ChatGPT returned an empty response.');
	const reader = response.body.getReader();
	let bytes = 0;
	let text = '';
	const decoder = new TextDecoder();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				throw new ChatGPTInferenceError('ChatGPT returned an oversized response.');
			}
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
		try {
			return JSON.parse(text);
		} catch {
			throw new ChatGPTInferenceError('ChatGPT returned an invalid response.');
		}
	} finally {
		reader.releaseLock();
	}
}
export async function listChatGPTModels(
	accessToken: string,
	fetcher: typeof fetch = fetch
): Promise<{
	providers: Array<{
		id: string;
		name: string;
		models: Array<{
			id: string;
			name: string;
			vision: boolean;
			reasoning?: { efforts: string[]; toggle: boolean };
		}>;
	}>;
}> {
	let response: Response;
	try {
		response = await fetcher('https://api.openai.com/v1/models', {
			headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
			redirect: 'error',
			signal: AbortSignal.timeout(20_000)
		});
	} catch {
		throw new ChatGPTInferenceError('Could not reach your ChatGPT model catalog. Try again.');
	}
	const body = await limitedJson(response);
	if (!response.ok) throw upstreamFailure(body, response.status);
	if (!Array.isArray(body.models))
		throw new ChatGPTInferenceError('ChatGPT returned an unexpected model catalog.');
	const models = body.models
		.filter(
			(model: any) =>
				model?.visibility === 'list' &&
				typeof model.slug === 'string' &&
				typeof model.display_name === 'string'
		)
		.map((model: any) => ({
			id: model.slug,
			name: model.display_name,
			...(Array.isArray(model.supported_reasoning_levels)
				? {
						reasoning: {
							efforts: model.supported_reasoning_levels
								.map((level: any) => level?.effort)
								.filter((effort: unknown) => typeof effort === 'string'),
							toggle: false
						}
					}
				: {}),
			vision: Array.isArray(model.input_modalities)
				? model.input_modalities.includes('image')
				: false
		}));
	if (!models.length)
		throw new ChatGPTInferenceError(
			'No eligible ChatGPT models are available for this account.',
			403
		);
	return { providers: [{ id: 'chatgpt', name: 'ChatGPT plan', models }] };
}
export async function chatGPTResponse(
	options: {
		accessToken: string;
		model: string;
		instructions: string;
		prompt: string;
		image?: string;
		reasoning?: ReasoningSettings;
	},
	fetcher: typeof fetch = fetch
): Promise<string> {
	const controller = AbortSignal.timeout(TIMEOUT_MS);
	const content = options.image
		? [
				{ type: 'input_text', text: options.prompt },
				{ type: 'input_image', image_url: options.image, detail: 'low' }
			]
		: [{ type: 'input_text', text: options.prompt }];
	let response: Response;
	try {
		response = await fetcher('https://api.openai.com/v1/responses', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${options.accessToken}`,
				'Content-Type': 'application/json',
				Accept: 'text/event-stream',
				'User-Agent': 'Flavorithm/1.0'
			},
			redirect: 'error',
			signal: controller,
			body: JSON.stringify({
				model: options.model,
				...(options.reasoning?.effort ? { reasoning: { effort: options.reasoning.effort } } : {}),
				instructions: options.instructions,
				input: [{ role: 'user', content }],
				store: false,
				stream: true
			})
		});
	} catch {
		throw new ChatGPTInferenceError(
			'Could not reach ChatGPT. Check your connection and try again.'
		);
	}
	if (!response.ok) {
		let body: unknown;
		try {
			body = await limitedJson(response);
		} catch {}
		throw upstreamFailure(body, response.status);
	}
	if (!response.body) throw new ChatGPTInferenceError('ChatGPT returned an empty stream.');
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let bytes = 0;
	let output = '';
	let completed = false;

	function consumeEvent(raw: string) {
		const data = raw
			.split('\n')
			.filter((line) => line.startsWith('data:'))
			.map((line) => line.slice(5).trimStart())
			.join('\n');
		if (!data || data === '[DONE]') return;
		let event: any;
		try {
			event = JSON.parse(data);
		} catch {
			throw new ChatGPTInferenceError('ChatGPT returned an invalid event stream.');
		}
		if (event.type === 'response.output_text.delta' && typeof event.delta === 'string')
			output += event.delta;
		if (event.type === 'response.failed' || event.type === 'error')
			throw upstreamFailure(event, 502);
		if (event.type === 'response.incomplete')
			throw new ChatGPTInferenceError(
				'ChatGPT stopped before finishing the recipe. Please try again.'
			);
		if (event.type === 'response.completed') {
			if (event.response?.status && event.response.status !== 'completed')
				throw new ChatGPTInferenceError('ChatGPT did not complete the request.');
			const finalText = Array.isArray(event.response?.output)
				? event.response.output
						.flatMap((item: any) => (Array.isArray(item.content) ? item.content : []))
						.filter((item: any) => item.type === 'output_text' && typeof item.text === 'string')
						.map((item: any) => item.text)
						.join('')
				: '';
			if (finalText) output = finalText;
			completed = true;
		}
	}
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES)
				throw new ChatGPTInferenceError('ChatGPT returned an oversized response.');
			buffer += decoder.decode(value, { stream: true });
			buffer = buffer.replace(/\r\n/g, '\n');
			let separator: number;
			while ((separator = buffer.indexOf('\n\n')) !== -1) {
				consumeEvent(buffer.slice(0, separator));
				buffer = buffer.slice(separator + 2);
			}
			if (completed) {
				await reader.cancel();
				break;
			}
		}
		buffer += decoder.decode();
		if (buffer.trim() && !completed) consumeEvent(buffer);
	} catch (error) {
		await reader.cancel().catch(() => {});
		if (error instanceof ChatGPTInferenceError) throw error;
		throw new ChatGPTInferenceError(
			'The ChatGPT connection was interrupted before completion. Please try again.'
		);
	} finally {
		reader.releaseLock();
	}
	if (!completed)
		throw new ChatGPTInferenceError(
			'ChatGPT ended the stream before confirming completion. No partial recipe was saved.'
		);
	if (!output.trim())
		throw new ChatGPTInferenceError(
			'ChatGPT completed without recipe text. Try a different request.'
		);
	return output;
}
