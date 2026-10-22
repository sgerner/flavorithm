import type { RequestHandler } from './$types';
import { ApiError, consumeRateLimit } from '#lib/server/db.ts';
import { ChatGPTOAuthError, handleHostedChatGPTCallback } from '#lib/server/chatgpt-oauth.ts';

export const GET: RequestHandler = async (event) => {
	try {
		let address: string;
		try {
			address = event.getClientAddress();
		} catch {
			return new Response('ChatGPT callback could not be accepted.', {
				status: 403,
				headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
			});
		}
		consumeRateLimit(`chatgpt-oauth-callback:${address}`, 30, 15 * 60 * 1000);
		return await handleHostedChatGPTCallback(event.url);
	} catch (error) {
		if (error instanceof ApiError) {
			return new Response('ChatGPT callback could not be accepted.', {
				status: error.status,
				headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
			});
		}
		if (error instanceof ChatGPTOAuthError) {
			return new Response('ChatGPT callback is unavailable.', {
				status: error.status,
				headers: {
					'Content-Type': 'text/plain; charset=utf-8',
					'Cache-Control': 'no-store, max-age=0',
					'X-Content-Type-Options': 'nosniff',
					'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
				}
			});
		}
		return new Response('ChatGPT callback could not be completed.', {
			status: 500,
			headers: {
				'Content-Type': 'text/plain; charset=utf-8',
				'Cache-Control': 'no-store, max-age=0',
				'X-Content-Type-Options': 'nosniff',
				'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
			}
		});
	}
};
