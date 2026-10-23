import type { User } from '#lib/types.ts';

declare global {
	namespace App {
		interface Locals {
			user: User | null;
			authMode: 'local' | 'oidc' | 'proxy' | 'invalid';
		}
	}
}

export {};
