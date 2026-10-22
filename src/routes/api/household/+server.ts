import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import {
	ApiError,
	assertSameOrigin,
	createHouseholdInvite,
	consumeRateLimit,
	errorResponse,
	joinHousehold,
	leaveHousehold,
	listHouseholdMembers,
	listHouseholdInvites,
	readJson,
	revokeHouseholdInvite,
	removeHouseholdMember
} from '#lib/server/db.ts';

const actionSchema = z.discriminatedUnion('action', [
	z.object({ action: z.literal('createInvite') }),
	z.object({ action: z.literal('revokeInvite'), inviteId: z.string().min(32).max(128) }),
	z.object({ action: z.literal('removeMember'), memberId: z.string().min(1).max(100) }),
	z.object({ action: z.literal('join'), code: z.string().min(8).max(100) }),
	z.object({ action: z.literal('leave') })
]);

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return json({ error: 'Authentication required' }, { status: 401 });
	const members = listHouseholdMembers(locals.user);
	return json({
		members,
		invites: listHouseholdInvites(locals.user),
		canManage: members.some((member) => member.id === locals.user?.id && member.role === 'owner')
	});
};

export const POST: RequestHandler = async (event) => {
	try {
		assertSameOrigin(event.request);
		if (!event.locals.user) throw new ApiError(401, 'Authentication required');
		consumeRateLimit(`household-user:${event.locals.user.id}`, 40, 60 * 60 * 1000);
		const parsed = actionSchema.safeParse(await readJson(event.request));
		if (!parsed.success) throw new ApiError(400, 'Please provide a valid household action');
		if (parsed.data.action === 'createInvite')
			return json(createHouseholdInvite(event.locals.user));
		if (parsed.data.action === 'revokeInvite') {
			revokeHouseholdInvite(event.locals.user, parsed.data.inviteId);
		} else if (parsed.data.action === 'removeMember') {
			removeHouseholdMember(event.locals.user, parsed.data.memberId);
		} else if (parsed.data.action === 'join') {
			event.locals.user = joinHousehold(event.locals.user, parsed.data.code);
		} else {
			event.locals.user = leaveHousehold(event.locals.user);
		}
		const members = listHouseholdMembers(event.locals.user);
		return json({
			members,
			invites: listHouseholdInvites(event.locals.user),
			canManage: members.some(
				(member) => member.id === event.locals.user?.id && member.role === 'owner'
			)
		});
	} catch (error) {
		return errorResponse(error);
	}
};
