import type { PageServerLoad } from './$types';
import { getAuthMetadata } from '#lib/server/sso.ts';

export const load: PageServerLoad = ({ locals }) => getAuthMetadata(locals.authMode);
