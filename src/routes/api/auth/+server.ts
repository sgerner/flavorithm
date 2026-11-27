import type { RequestHandler } from './$types';
import { z } from 'zod';
import {
	ApiError,
	assertSameOrigin,
	clientAddress,
	consumeRateLimit,
	deleteUserAccount,
	deleteSession,
	errorResponse,
	issueEmailVerification,
	issuePasswordReset,
	loginUser,
	readJson,
	registerUser,
	resetUserPassword,
	rotateUserCredentials,
	sendEmailVerificationEmail,
	sendPasswordResetEmail,
	updateAccountProfile,
	verifyEmailToken
} from '#lib/server/db.ts';
import { getAuthMetadata, getAuthMode } from '#lib/server/sso.ts';

const authActionSchema = z.discriminatedUnion('action', [
	z.object({
		action: z.literal('register'),
		name: z.string().trim().min(2).max(80),
		email: z.string().trim().max(254).pipe(z.email()),
		password: z.string().min(10).max(128)
	}),
	z.object({
		action: z.literal('login'),
		name: z.string().optional(),
		email: z.string().trim().max(254).pipe(z.email()),
		password: z.string().min(1).max(128)
	}),
	z.object({ action: z.literal('logout') }),
	z.object({ action: z.literal('deleteAccount'), password: z.string().min(1).max(128) }),
	z.object({
		action: z.literal('changePassword'),
		currentPassword: z.string().min(1).max(128),
		newPassword: z.string().min(10).max(128)
	}),
	z.object({
		action: z.literal('updateAccountProfile'),
		name: z.string().trim().min(2).max(80).optional(),
		email: z.string().trim().max(254).pipe(z.email()).optional(),
		currentPassword: z.string().max(128).optional()
	}),
	z.object({
		action: z.literal('requestPasswordReset'),
		email: z.string().trim().max(254).pipe(z.email())
	}),
	z.object({
		action: z.literal('resetPassword'),
		token: z.string().min(20).max(200),
		password: z.string().min(10).max(128)
	}),
	z.object({ action: z.literal('requestEmailVerification') }),
	z.object({ action: z.literal('verifyEmail'), token: z.string().min(20).max(200) })
]);

function passwordResetOrigin(request: Request): string {
	const configuredOrigin = process.env.ORIGIN?.trim();
	if (!configuredOrigin && !request.headers.get('origin')) {
		throw new ApiError(
			503,
			'Email links require a public site address. Ask the server operator to configure this installation.'
		);
	}
	try {
		const trustedOrigin = request.headers.get('origin');
		const url = configuredOrigin ? new URL(configuredOrigin) : new URL(trustedOrigin!);
		if (url.protocol !== 'https:' && url.protocol !== 'http:')
			throw new Error('Unsupported origin protocol');
		return url.origin;
	} catch {
		throw new ApiError(503, 'Password recovery URL is not configured correctly.');
	}
}

function setSessionCookie(
	cookies: Parameters<RequestHandler>[0]['cookies'],
	request: Request,
	token: string,
	expiresAt: number
) {
	const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
	cookies.set('flavorithm_session', token, {
		path: '/',
		httpOnly: true,
		secure: new URL(request.url).protocol === 'https:' || forwardedProto === 'https',
		sameSite: 'lax',
		expires: new Date(expiresAt),
		maxAge: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
	});
}

export const GET: RequestHandler = async ({ locals }) => {
	const authMode = locals.authMode ?? getAuthMode() ?? 'invalid';
	const authMetadata = getAuthMetadata(authMode);
	return Response.json({
		user: locals.user,
		...authMetadata,
		capabilities: {
			emailDelivery: Boolean(process.env.RESEND_API_KEY?.trim() && process.env.EMAIL_FROM?.trim()),
			recipeSearch: Boolean(process.env.BRAVE_SEARCH_API_KEY?.trim())
		}
	});
};

export const POST: RequestHandler = async (event) => {
	try {
		assertSameOrigin(event.request);
		const authMode = event.locals.authMode ?? getAuthMode() ?? 'invalid';
		if (authMode !== 'local') {
			throw new ApiError(403, 'Local password authentication is disabled for this installation.');
		}
		const parsed = authActionSchema.safeParse(await readJson(event.request));
		if (!parsed.success)
			throw new ApiError(400, 'Please provide a valid auth action, email and password');
		const payload = parsed.data;
		if (payload.action === 'logout') {
			deleteSession(event.cookies.get('flavorithm_session'));
			event.cookies.delete('flavorithm_session', { path: '/' });
			return Response.json({ user: null });
		}
		const ip = clientAddress(event);
		if (!ip) throw new ApiError(403, 'The request source could not be verified');
		consumeRateLimit(`auth-ip:${ip}`, 20, 15 * 60 * 1000);
		if (payload.action === 'deleteAccount') {
			if (!event.locals.user) throw new ApiError(401, 'Authentication required');
			consumeRateLimit(`delete-account:${event.locals.user.id}`, 5, 15 * 60 * 1000);
			await deleteUserAccount(event.locals.user.id, payload.password);
			event.cookies.delete('flavorithm_session', { path: '/' });
			return Response.json({ user: null });
		}
		if (payload.action === 'changePassword') {
			if (!event.locals.user) throw new ApiError(401, 'Authentication required');
			consumeRateLimit(`change-password:${event.locals.user.id}`, 5, 15 * 60 * 1000);
			const result = await rotateUserCredentials(
				event.locals.user.id,
				payload.currentPassword,
				payload.newPassword
			);
			setSessionCookie(event.cookies, event.request, result.token, result.expiresAt);
			return Response.json({ user: result.user });
		}
		if (payload.action === 'updateAccountProfile') {
			if (!event.locals.user) throw new ApiError(401, 'Authentication required');
			consumeRateLimit(`account-profile:${event.locals.user.id}`, 10, 15 * 60 * 1000);
			const result = await updateAccountProfile(event.locals.user.id, {
				name: payload.name,
				email: payload.email,
				currentPassword: payload.currentPassword
			});
			if (result.token && result.expiresAt !== undefined) {
				setSessionCookie(event.cookies, event.request, result.token, result.expiresAt);
			}
			return Response.json({ user: result.user });
		}
		if (payload.action === 'requestPasswordReset') {
			const apiKey = process.env.RESEND_API_KEY?.trim();
			const from = process.env.EMAIL_FROM?.trim();
			if (!apiKey || !from) {
				throw new ApiError(
					503,
					'Password recovery is not configured on this installation. Ask the server operator to configure email delivery.'
				);
			}
			const email = payload.email.toLowerCase();
			consumeRateLimit(`password-reset-ip:${ip}`, 5, 60 * 60 * 1000);
			consumeRateLimit(`password-reset-email:${email}`, 3, 60 * 60 * 1000);
			const origin = passwordResetOrigin(event.request);
			const reset = await issuePasswordReset(email);
			if (reset) {
				const resetUrl = new URL('/', origin);
				resetUrl.searchParams.set('reset', reset.token);
				const sent = await sendPasswordResetEmail(reset.email, resetUrl.toString(), apiKey, from);
				if (!sent) console.warn('Password reset email delivery failed.');
			}
			return Response.json({
				message: 'If an account exists, a password reset link will be sent.'
			});
		}
		if (payload.action === 'requestEmailVerification') {
			if (!event.locals.user) throw new ApiError(401, 'Authentication required');
			const apiKey = process.env.RESEND_API_KEY?.trim();
			const from = process.env.EMAIL_FROM?.trim();
			if (!apiKey || !from) {
				throw new ApiError(
					503,
					'Email verification is not configured on this installation. Ask the server operator to configure email delivery.'
				);
			}
			consumeRateLimit(`email-verify-ip:${ip}`, 5, 60 * 60 * 1000);
			consumeRateLimit(`email-verify-user:${event.locals.user.id}`, 3, 60 * 60 * 1000);
			const origin = passwordResetOrigin(event.request);
			const verification = issueEmailVerification(event.locals.user.id);
			if (verification) {
				const verificationUrl = new URL('/', origin);
				verificationUrl.searchParams.set('verify', verification.token);
				const sent = await sendEmailVerificationEmail(
					verification.email,
					verificationUrl.toString(),
					apiKey,
					from
				);
				if (!sent) console.warn('Email verification delivery failed.');
			}
			return Response.json({ message: 'If your email needs verification, a link will be sent.' });
		}
		if (payload.action === 'verifyEmail') {
			consumeRateLimit(`email-verify-complete-ip:${ip}`, 10, 15 * 60 * 1000);
			return Response.json({ user: verifyEmailToken(payload.token) });
		}
		if (payload.action === 'resetPassword') {
			consumeRateLimit(`password-reset-complete-ip:${ip}`, 10, 15 * 60 * 1000);
			await resetUserPassword(payload.token, payload.password);
			event.cookies.delete('flavorithm_session', { path: '/' });
			return Response.json({ user: null });
		}

		const email = payload.email.toLowerCase();
		consumeRateLimit(`auth-email:${email}`, 10, 15 * 60 * 1000);
		if (payload.action === 'register') {
			consumeRateLimit(`register-ip:${ip}`, 5, 60 * 60 * 1000);
			const result = await registerUser(payload.name, email, payload.password);
			setSessionCookie(event.cookies, event.request, result.token, result.expiresAt);
			return Response.json({ user: result.user }, { status: 201 });
		}

		const result = await loginUser(email, payload.password);
		setSessionCookie(event.cookies, event.request, result.token, result.expiresAt);
		return Response.json({ user: result.user });
	} catch (error) {
		return errorResponse(error);
	}
};
