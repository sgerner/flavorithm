import {
	configureHostAI,
	getHostAI,
	isHostAdmin,
	HOST_CONNECTION_ID
} from '#lib/server/host-ai.ts';
import { startCodexDevice, pollCodexDevice, cancelCodexDevice } from '#lib/server/codex-device.ts';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { ApiError, consumeRateLimit, getSessionBinding } from '#lib/server/db.ts';
import {
	ChatGPTOAuthError,
	disconnectChatGPTAccount,
	enforceChatGPTStartRateLimit,
	getChatGPTOAuthAvailability,
	listChatGPTAccounts,
	startChatGPTOAuth,
	finishChatGPTCompanion
} from '#lib/server/chatgpt-oauth.ts';

const bodySchema = z.discriminatedUnion('action', [
	z.object({
		action: z.literal('host'),
		accountId: z.string().min(1).max(100).optional(),
		model: z.string().min(1).max(200).optional()
	}),
	z.object({
		action: z.literal('start'),
		accountId: z.string().min(1).max(100).optional(),
		reconsent: z.boolean().optional()
	}),
	z.object({ action: z.literal('disconnect'), accountId: z.string().min(1).max(100) }),
	z.object({ action: z.literal('poll'), loginId: z.string().uuid() }),
	z.object({ action: z.literal('cancel'), loginId: z.string().uuid() }),
	z.object({
		action: z.literal('import'),
		bundle: z.object({
			version: z.literal(1),
			pairingId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
			iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
			tag: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
			data: z
				.string()
				.regex(/^[A-Za-z0-9_-]+$/)
				.max(90_000)
		})
	})
]);

function requestAddress(event: Parameters<RequestHandler>[0]): string | null {
	try {
		return event.getClientAddress();
	} catch {
		return null;
	}
}

function handleError(error: unknown): Response {
	if (error instanceof ChatGPTOAuthError) {
		return json({ error: error.message, code: error.code }, { status: error.status });
	}
	if (error instanceof ApiError) return json({ error: error.message }, { status: error.status });
	return json({ error: 'The ChatGPT connection request could not be completed.' }, { status: 500 });
}

export const GET: RequestHandler = async (event) => {
	if (!event.locals.user) return json({ error: 'Authentication required' }, { status: 401 });
	const address = requestAddress(event);
	const availability = getChatGPTOAuthAvailability({ url: event.url, clientAddress: address });
	return json(
		{
			hostAdmin: isHostAdmin(event.locals.user.id),
			host: getHostAI() ? { model: getHostAI()!.model } : null,
			configured: availability.mode !== 'unavailable',
			mode: availability.mode,
			accounts: [
				...(getHostAI()
					? [
							{
								id: HOST_CONNECTION_ID,
								label: 'Host ChatGPT connection',
								connected: true,
								planEnabled: true
							}
						]
					: []),
				...listChatGPTAccounts(event.locals.user.id)
			],
			...(availability.safeReason ? { safeReason: availability.safeReason } : {})
		},
		{ headers: { 'Cache-Control': 'no-store, max-age=0' } }
	);
};

export const POST: RequestHandler = async (event) => {
	try {
		const origin = event.request.headers.get('origin');
		if (!origin || origin !== event.url.origin)
			throw new ApiError(403, 'Cross-origin request rejected');
		const fetchSite = event.request.headers.get('sec-fetch-site');
		if (fetchSite && fetchSite !== 'same-origin')
			throw new ApiError(403, 'Cross-origin request rejected');
		if (!event.locals.user) throw new ApiError(401, 'Authentication required');
		const address = requestAddress(event);
		if (!address) throw new ApiError(403, 'The request source could not be verified');
		consumeRateLimit(`chatgpt-connection-ip:${address}`, 600, 15 * 60 * 1000);

		const contentLength = Number(event.request.headers.get('content-length') ?? 0);
		if (Number.isFinite(contentLength) && contentLength > 100_000)
			throw new ApiError(413, 'Request body is too large');
		const body = await event.request.text();
		if (Buffer.byteLength(body, 'utf8') > 100_000)
			throw new ApiError(413, 'Request body is too large');
		let value: unknown;
		try {
			value = JSON.parse(body) as unknown;
		} catch {
			throw new ApiError(400, 'Request body must be valid JSON');
		}
		const parsed = bodySchema.safeParse(value);
		if (!parsed.success)
			throw new ApiError(400, 'Please provide a valid ChatGPT connection action');
		if (parsed.data.action !== 'import' && Buffer.byteLength(body, 'utf8') > 4_096)
			throw new ApiError(413, 'Request body is too large');

		if (parsed.data.action === 'host') {
			configureHostAI(event.locals.user.id, parsed.data.accountId, parsed.data.model);
			return json({ enabled: Boolean(getHostAI()) }, { headers: { 'Cache-Control': 'no-store' } });
		}

		if (parsed.data.action === 'disconnect') {
			consumeRateLimit(`chatgpt-disconnect:${event.locals.user.id}`, 20, 15 * 60 * 1000);
			return json(await disconnectChatGPTAccount(event.locals.user.id, parsed.data.accountId));
		}

		const sessionToken = event.cookies.get('flavorithm_session');
		const sessionBinding = getSessionBinding(sessionToken);
		if (!sessionBinding) throw new ApiError(401, 'Authentication required');
		if (parsed.data.action === 'poll' || parsed.data.action === 'cancel') {
			consumeRateLimit(`chatgpt-device:${event.locals.user.id}`, 400, 15 * 60 * 1000);
			const input = {
				userId: event.locals.user.id,
				sessionBinding,
				appUrl: event.url,
				loginId: parsed.data.loginId
			};
			return json(
				parsed.data.action === 'poll' ? await pollCodexDevice(input) : cancelCodexDevice(input),
				{ headers: { 'Cache-Control': 'no-store' } }
			);
		}
		if (parsed.data.action === 'import') {
			consumeRateLimit(`chatgpt-import:${event.locals.user.id}`, 20, 15 * 60 * 1000);
			return json(
				await finishChatGPTCompanion({
					userId: event.locals.user.id,
					sessionBinding,
					appUrl: event.url,
					bundle: parsed.data.bundle
				}),
				{ headers: { 'Cache-Control': 'no-store' } }
			);
		}
		const availability = getChatGPTOAuthAvailability({ url: event.url, clientAddress: address });
		if (availability.mode === 'unavailable') {
			throw new ChatGPTOAuthError(
				503,
				availability.safeReason ?? 'ChatGPT OAuth is unavailable.',
				'chatgpt_oauth_unavailable'
			);
		}
		enforceChatGPTStartRateLimit(event.locals.user.id, address);
		if (availability.mode === 'device')
			return json(
				await startCodexDevice({
					userId: event.locals.user.id,
					sessionBinding,
					appUrl: event.url,
					accountId: parsed.data.accountId
				}),
				{ headers: { 'Cache-Control': 'no-store' } }
			);
		const result = await startChatGPTOAuth({
			userId: event.locals.user.id,
			sessionBinding,
			appUrl: event.url,
			mode: availability.mode,
			...(parsed.data.accountId ? { accountId: parsed.data.accountId } : {}),
			reconsent: parsed.data.reconsent ?? false
		});
		return json(result, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
	} catch (error) {
		return handleError(error);
	}
};
