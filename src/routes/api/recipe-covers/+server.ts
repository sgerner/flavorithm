import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ApiError, assertSameOrigin, errorResponse } from '#lib/server/db.ts';
import { storeCover } from '#lib/server/recipe-covers.ts';
import { MAX_COVER_BYTES } from '#lib/cover-upload.ts';

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		assertSameOrigin(request);
		if (!locals.user) throw new ApiError(401, 'Sign in to upload a cover photo.');
		if (request.headers.get('content-type') !== 'image/jpeg')
			throw new ApiError(400, 'Upload a JPEG cover photo.');
		const reader = request.body?.getReader();
		if (!reader) throw new ApiError(400, 'A photo is required.');
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.length;
				if (size > MAX_COVER_BYTES) {
					await reader.cancel();
					throw new ApiError(413, 'Cover photo is too large.');
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		return json({ image: await storeCover(locals.user.householdId, Buffer.concat(chunks)) });
	} catch (error) {
		return errorResponse(error);
	}
};
