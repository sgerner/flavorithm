import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ApiError, assertSameOrigin, consumeRateLimit } from '#lib/server/db.ts';
import { localWhisperUrl, transcribeVoice } from '#lib/server/voice.ts';
import { MAX_WAV_BYTES } from '#lib/voice-config.ts';
const headers = { 'cache-control': 'no-store' };
export const GET: RequestHandler = ({ locals }) => {
	if (!locals.user)
		return json({ error: 'Sign in to configure voice input.' }, { status: 401, headers });
	return json({ localAvailable: Boolean(localWhisperUrl()) }, { headers });
};
export const POST: RequestHandler = async ({ request, locals, fetch }) => {
	try {
		assertSameOrigin(request);
		if (!locals.user) throw new ApiError(401, 'Sign in to use voice transcription.');
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
		return json(await transcribeVoice(form, fetch, request.signal), { headers });
	} catch (error) {
		return json(
			{
				error:
					error instanceof ApiError ? error.message : 'Voice transcription could not be completed.'
			},
			{ status: error instanceof ApiError ? error.status : 500, headers }
		);
	}
};
