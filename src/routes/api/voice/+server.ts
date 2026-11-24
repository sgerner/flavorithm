import type { RequestHandler } from './$types';
import { ApiError, assertSameOrigin, consumeRateLimit } from '#lib/server/db.ts';
import { probeLocalWhisper, transcribeVoice } from '#lib/server/voice.ts';
import { MAX_WAV_BYTES } from '#lib/voice-config.ts';
const headers = { 'cache-control': 'no-store' };
export const GET: RequestHandler = async ({ locals, fetch: eventFetch, request }) => {
	if (!locals.user)
		return Response.json(
			{ error: 'Sign in to configure voice input.', code: 'session_expired' },
			{ status: 401, headers }
		);
	return Response.json(
		{ localAvailable: await probeLocalWhisper(eventFetch ?? fetch, request?.signal) },
		{ headers }
	);
};
export const POST: RequestHandler = async ({ request, locals, fetch }) => {
	try {
		assertSameOrigin(request);
		if (!locals.user)
			throw new ApiError(401, 'Sign in to use voice transcription.', 'session_expired');
		consumeRateLimit(`voice:${locals.user.id}`, 30, 60 * 60 * 1000);
		const contentType = request.headers.get('content-type') || '';
		if (!contentType.startsWith('multipart/form-data;'))
			throw new ApiError(400, 'Upload a microphone recording.');
		const limit = MAX_WAV_BYTES + 16_384;
		if (Number(request.headers.get('content-length')) > limit)
			throw new ApiError(413, 'Recording is too large.');
		const reader = request.body?.getReader();
		if (!reader) throw new ApiError(400, 'Record some audio first.');
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > limit) {
					void reader.cancel().catch(() => {});
					throw new ApiError(413, 'Recording is too large.');
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		let form: FormData;
		try {
			form = await new Response(Buffer.concat(chunks), {
				headers: { 'content-type': contentType }
			}).formData();
		} catch {
			throw new ApiError(400, 'Could not read the recording.');
		}
		return Response.json(await transcribeVoice(form, fetch, request.signal), { headers });
	} catch (error) {
		return Response.json(
			{
				error:
					error instanceof ApiError ? error.message : 'Voice transcription could not be completed.',
				...(error instanceof ApiError && error.code ? { code: error.code } : {})
			},
			{ status: error instanceof ApiError ? error.status : 500, headers }
		);
	}
};
